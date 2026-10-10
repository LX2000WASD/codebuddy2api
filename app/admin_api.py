"""Explicitly installed v1 management API; importing this module has no side effects."""
from __future__ import annotations

from collections import OrderedDict
import io
import json
from pathlib import Path
import threading
import time
from urllib.parse import quote, urlsplit
import uuid
import zipfile

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, Response

from . import auth_oauth
from .admin_auth import AdminAuth, AdminMiddleware, COOKIE_NAME, SESSION_TTL, error_response, same_origin
from .audit_store import stats_view
from .control_store import ConflictError, validate_model
from .credential_io import CredentialFileError, MAX_CREDENTIAL_BYTES, _valid_name, read_import_file
from .health_endpoints import int_param
from .settings import SCHEMA, resolve_settings, validate_settings

MAX_UPLOAD_BYTES = 32 * 1024 * 1024
CLEAR_CONFIRMATION = "清空全部日志与统计"


async def _body(request, maximum=65536, *, allow_empty=False):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > maximum:
            raise ValueError("请求体超过大小限制")
    if allow_empty and not data:
        return {}
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("请求体必须是有效 JSON 对象") from None
    if not isinstance(value, dict):
        raise ValueError("请求体必须是 JSON 对象")
    return value


def _unbind_requested(query: str) -> bool:
    """Mirror the delete route's Boolean query parsing for the unbind confirmation flag."""
    for pair in (query or "").split("&"):
        key, _, value = pair.partition("=")
        if key == "unbind" and value.lower() in ("1", "true", "on", "yes"):
            return True
    return False


def _public_credential(item):
    # Never pass arbitrary credential manager fields through to the browser.
    fields = {"id", "account_key", "name", "filename", "enabled", "label", "profile", "region", "site",
              "uid", "nickname", "expires_at", "expiresAt", "health", "cooldown", "cooldowns", "credits",
              "credits_by_profile", "catalog", "catalog_sync", "sync", "generation", "auth_broken",
              "models", "remaining", "enterprise_id", "product", "status", "sync_pending", "sync_error",
              "fail_until", "cooldown_until", "cooldown_remaining", "last_failure_at", "catalog_ready", "bindings",
              "auto_checkin", "auto_travel", "travel_supported", "checkin", "travel",
              "trial_supported", "trial",
              "daily_chat_supported", "auto_daily_chat", "daily_chat",
              "token_expired", "token_expires_at", "last_refresh_time", "sessions", "sticky_sessions", "last_error_code",
              # Legacy companions consumed by non-WebUI clients (cpa-plugin status page).
              "healthy", "enterpriseName", "auth_file"}
    result = {key: value for key, value in item.items() if key in fields}
    identity = item.get("account_key") or item.get("id")
    if identity and ("/" in str(identity) or "\\" in str(identity)):
        identity = item.get("account_key")
    result["id"] = identity
    # gateway_management pops auth_file for its own bookkeeping; restore the filename
    # alias so legacy clients keep working.
    result.setdefault("auth_file", item.get("name") or item.get("filename"))
    for field in ("name", "filename"):
        if field in result:
            result[field] = Path(str(result[field])).name
    return result


def install_admin(app, config, gateway):
    """Install management routes using configured stores, stable inventory IDs and safe filenames."""
    if getattr(app.state, "admin_installed", False):
        return app.state.admin_auth
    control, audit = config["control_store"], config["audit_store"]
    auth = AdminAuth(config)
    # Resolve the key epoch now: a process that only serves inference traffic would
    # otherwise never clear a snapshot belonging to a superseded key.
    auth.reconcile()
    mutation_lock = threading.RLock()
    # The confirmed credential delete shares this lock so rule edits cannot interleave.
    config["admin_mutation_lock"] = mutation_lock
    oauth_lock = threading.RLock()
    oauth_tasks = OrderedDict()

    def event(action, details=None):
        try:
            audit.event("admin", action, details)
        except Exception:
            # AuditStore owns its degraded state; audit failure must not leak secrets.
            pass

    def inventory():
        return gateway.admin_credential_inventory()

    def selected(identity):
        return next((item for item in inventory() if identity == (item.get("account_key") or item.get("id"))), None)

    def known_models():
        return [item["id"] if isinstance(item, dict) else item for item in gateway.admin_model_inventory()]

    def settings_result():
        items = resolve_settings(config)
        for name, label in (("CRED_COOLDOWN", "认证熔断冷却秒数"),
                            ("MODEL_COOLDOWN", "模型冷却兜底秒数"),
                            ("MODEL_COOLDOWN_MAX", "模型冷却最大秒数"),
                            ("STICKY_TTL", "黏绑空闲期限秒数")):
            value = getattr(gateway, name, None)
            if type(value) in (int, float):
                items.append({"key": name.lower(), "value": value, "stored": None, "source": "internal",
                              "mode": "readonly", "type": "number", "label": label, "locked": True})
        items.append({"key": "auto_accept_buddy", "value": config.get("auto_accept_buddy") is True,
                      "stored": None, "source": config.get("auto_accept_buddy_source", "default"),
                      "mode": "startup", "type": "boolean", "label": "全部国内账号首次领猫预授权", "locked": True})
        return {"revision": control.snapshot()["revision"], "items": items, "audit": audit.storage(),
                "session": auth.storage()}

    def audit_settings(values):
        mapping = {"audit_max_bytes": "max_bytes", "audit_retention_days": "retention_days",
                   "audit_diagnostic_bytes": "preview_limit"}
        return {mapping[key]: value for key, value in values.items() if key in mapping}

    def oauth_dispatch(request):
        identity = request.state.admin_identity
        now = time.monotonic()
        with oauth_lock:
            for task_id, task in list(oauth_tasks.items()):
                if task["expires"] <= now:
                    del oauth_tasks[task_id]
            if request.url.path == "/admin/oauth/start":
                site = request.query_params.get("site", "cn")
                if site not in auth_oauth.SITE_HOSTS:
                    return error_response(400, f"OAuth 站点必须为 {'、'.join(auth_oauth.SITE_HOSTS)}")
                if len(oauth_tasks) >= 256:
                    return error_response(429, "OAuth 任务过多，请稍后重试")
                try:
                    result = gateway._OAUTH.start(site=site)
                    login_id = result.get("login_id")
                    link = result.get("verification_uri") or result.get("url") or result.get("auth_url") or result.get("login_url")
                    parsed = urlsplit(link or "")
                    if (not login_id or not isinstance(login_id, str) or parsed.scheme != "https"
                            or parsed.username or parsed.password or parsed.port not in (None, 443)
                            or f"https://{parsed.hostname}" not in auth_oauth.ALLOWED_ORIGINS):
                        return error_response(502, "OAuth 返回的授权链接无效")
                    oauth_tasks[login_id] = {"owner": identity, "expires": now + 600, "result": None}
                    return JSONResponse({"login_id": login_id, "verification_uri": link,
                                         **({"expires_in": result["expires_in"]} if "expires_in" in result else {})})
                except Exception:
                    return error_response(502, "OAuth 发起失败，请稍后重试")
            task_id = request.query_params.get("login_id", "")
            task = oauth_tasks.get(task_id)
            if not task or task["owner"] != identity:
                return error_response(404, "OAuth 任务不存在、已过期或不属于当前会话")
            if task["result"] is not None:
                return JSONResponse(task["result"])
            try:
                result = gateway._OAUTH.poll(task_id)
                if not result.get("done"):
                    return JSONResponse({"done": False})
                if result.get("error") or not result.get("cred"):
                    task["result"] = {"done": True, "error": "OAuth 登录失败，请重新发起"}
                else:
                    # Hold the task lock across save so concurrent polls cannot save twice.
                    target = gateway._save_oauth_credential(result["cred"])
                    task["result"] = {"done": True, "uid": result.get("uid"),
                                      "nickname": result.get("nickname") or "", "imported": Path(target).name}
                    event("oauth.saved")
                return JSONResponse(task["result"])
            except Exception:
                task["result"] = {"done": True, "error": "OAuth 轮询或凭证保存失败，请重新发起"}
                return JSONResponse(task["result"])

    async def dispatch(request):
        path, method = request.url.path, request.method
        if (path, method) in (("/admin/oauth/start", "POST"), ("/admin/oauth/poll", "GET")):
            return await run_in_threadpool(oauth_dispatch, request)
        if path == "/admin/credentials" and method == "GET":
            return JSONResponse({"credentials": [_public_credential(item) for item in await run_in_threadpool(inventory)]})
        if path.startswith("/admin/credentials/") and method == "DELETE":
            name = path.removeprefix("/admin/credentials/")
            if not _valid_name(name):
                return error_response(400, "凭证文件名无效")
            if not _unbind_requested(request.url.query):
                try:
                    await run_in_threadpool(gateway.admin_delete_guard, name)
                except (ValueError, HTTPException):
                    return error_response(409, "凭证仍被模型策略引用，请先移除绑定")
        return None

    # Middleware is deliberately installed only here, never on module import.
    app.add_middleware(AdminMiddleware, auth=auth, dispatch=dispatch)
    app.state.admin_auth = auth
    app.state.admin_installed = True

    def route(method, path):
        def decorate(function):
            async def guarded(request: Request):
                try:
                    result = await function(request)
                    return result
                except ConflictError:
                    return error_response(409, "配置已更新，请刷新后重试")
                except HTTPException as exc:
                    return error_response(exc.status_code, "管理操作不符合当前状态，请刷新后重试")
                except ValueError:
                    return error_response(400, "请求参数、配置或策略无效，请检查类型、范围及冲突")
                except Exception:
                    return error_response(500, "管理操作失败，请检查存储状态后重试")
            guarded.__name__ = function.__name__
            app.add_api_route(path, guarded, methods=[method])
            return function
        return decorate

    @route("POST", "/admin/session")
    async def session_login(request):
        if auth.csrf_enabled() and not same_origin(request, auth.allowed_origins()):
            return error_response(403, "登录请求 Origin 校验失败")
        data = await _body(request, 8192)
        result, status = auth.login(request, data.get("api_key"))
        if not result:
            return error_response(status, "登录尝试过多，请稍后重试" if status == 429 else "API key 无效")
        sid, session = result
        response = JSONResponse({"authenticated": True, "csrf_token": session["csrf_token"]})
        response.set_cookie(COOKIE_NAME, sid, max_age=SESSION_TTL, httponly=True, secure=request.url.scheme == "https", samesite="strict", path="/admin")
        return response

    @route("GET", "/admin/session")
    async def session_get(request):
        _, session = auth.session(request)
        return JSONResponse({"authenticated": bool(session or auth.header_identity(request)),
                             "csrf_token": session["csrf_token"] if session else None})

    @route("DELETE", "/admin/session")
    async def session_delete(request):
        if not auth.logout(request):
            # The session is still valid on disk; keep the cookie so the client can retry.
            event("session.revoke_failed", {"code": "session_storage_unavailable"})
            return error_response(503, "会话未能持久撤销，请检查管理目录权限后重试")
        response = JSONResponse({"authenticated": False})
        response.delete_cookie(COOKIE_NAME, path="/admin", httponly=True, samesite="strict", secure=request.url.scheme == "https")
        return response

    @route("GET", "/admin/settings")
    async def settings_get(request):
        return JSONResponse(await run_in_threadpool(settings_result))

    @route("PATCH", "/admin/settings")
    async def settings_patch(request):
        body = await _body(request)
        values = validate_settings(body.get("values"))
        locked = {item["key"] for item in resolve_settings(config) if item["locked"]}
        if values.keys() & locked:
            raise ValueError("配置由 CLI 或环境变量锁定，请修改启动来源")
        def apply():
            with mutation_lock:
                control.update_settings(values, body.get("revision"))
                hot = {key: value for key, value in values.items() if SCHEMA[key]["mode"] == "hot"}
                if audit_settings(hot):
                    configured = audit.configure(**audit_settings(hot))
                    if isinstance(configured, dict) and configured.get("ok") is False:
                        return error_response(503, "配置已保存，但尚未应用；请检查审计存储后重试或重启")
                gateway.admin_apply_settings(hot)
                config.update(hot)
                config.setdefault("settings_sources", {}).update({key: "management" for key in hot})
            for key in values:
                event("settings.updated", {"code": key})
            return JSONResponse(settings_result())
        return await run_in_threadpool(apply)

    @route("GET", "/admin/models")
    async def models_get(request):
        def build_models():
            with mutation_lock:
                inventory = gateway.admin_model_inventory()
                snapshot = control.snapshot()  # Read policy after account identity synchronization.
                models = []
                for item in inventory:
                    item = {"id": item} if isinstance(item, str) else dict(item)
                    source = item["id"]
                    rule = snapshot["models"].get(source, {"public_id": source, "enabled": True, "keep_original": False,
                                                           "region": None, "profile": None, "credential_ids": []})
                    models.append({**item, **rule})
                return JSONResponse({"revision": snapshot["revision"], "models": models,
                                     "model_capability_guard": config.get("model_capability_guard", True)})
        return await run_in_threadpool(build_models)

    def checked_rule(source, data, *, creating=False):
        if "custom" in data:
            raise ValueError("custom 是只读字段")
        existing = control.snapshot()["models"].get(source, {})
        if creating and (not data.get("public_id") or not data.get("upstream_id")):
            raise ValueError("对外 ID 和上游模型 ID 均不能为空")
        values = {"upstream_id": existing.get("upstream_id", source), **data,
                  "custom": True if creating else existing.get("custom", False)}
        rule = validate_model(source, values, control.snapshot()["models"], known_models())
        for identity in rule["credential_ids"]:
            item = selected(identity)
            if item is None:
                raise ValueError("绑定凭证不存在")
            profile = item.get("profile")
            if profile and ((rule["profile"] and rule["profile"] != profile)
                            or (rule["region"] and not profile.startswith(rule["region"] + "-"))):
                raise ValueError("绑定凭证与区域或产品规则冲突")
        return rule

    @route("POST", "/admin/models")
    async def models_create(request):
        data = await _body(request)
        revision = data.pop("revision", None)
        source = "custom:" + uuid.uuid4().hex
        def apply():
            with mutation_lock:
                rule = checked_rule(source, data, creating=True)
                snapshot = control.update_model(source, rule, revision, known_models())
            event("model.created", {"model": rule["public_id"]})
            return JSONResponse({"revision": snapshot["revision"], "model": {"id": source, **rule}}, status_code=201)
        return await run_in_threadpool(apply)

    @route("POST", "/admin/models/preview")
    async def models_create_preview(request):
        data = await _body(request)
        data.pop("revision", None)
        source = "custom:" + uuid.uuid4().hex
        def preview():
            return JSONResponse(gateway.admin_model_preview(source, checked_rule(source, data, creating=True)))
        return await run_in_threadpool(preview)

    @route("DELETE", "/admin/models/{id:path}")
    async def models_delete(request):
        data = await _body(request)
        if set(data) != {"revision"}:
            raise ValueError("删除模型只接受 revision")
        source = request.path_params["id"]
        def remove():
            with mutation_lock:
                snapshot = control.delete_model(source, data["revision"])
            event("model.deleted", {"model": source})
            return JSONResponse({"revision": snapshot["revision"], "ok": True})
        return await run_in_threadpool(remove)


    @route("PUT", "/admin/models/{id:path}")
    async def models_put(request):
        data = await _body(request)
        revision = data.pop("revision", None)
        source = request.path_params["id"]
        def apply():
            with mutation_lock:
                rule = checked_rule(source, data)
                snapshot = control.update_model(source, rule, revision, known_models())
            event("model.updated", {"model": source})
            return JSONResponse({"revision": snapshot["revision"], "model": {"id": source, **rule}})
        return await run_in_threadpool(apply)

    @route("POST", "/admin/models/{id:path}/preview")
    async def models_preview(request):
        data = await _body(request)
        data.pop("revision", None)
        source = request.path_params["id"]
        def preview():
            return JSONResponse(gateway.admin_model_preview(source, checked_rule(source, data)))
        return await run_in_threadpool(preview)

    @route("PATCH", "/admin/credentials/{id}")
    async def credentials_patch(request):
        data = await _body(request)
        if set(data) not in ({"enabled"}, {"paused"}, {"auto_checkin"}, {"auto_travel"}, {"auto_daily_chat"}) or any(type(value) is not bool for value in data.values()):
            raise ValueError("仅接受一个布尔字段：enabled、paused、auto_checkin、auto_travel 或 auto_daily_chat")
        field, value = next(iter(data.items()))
        identity = request.path_params["id"]
        # Fusion-A: paused 与 enabled 是两个正交开关——暂停只退出选号（签到/旅行/保号
        # 照跑），停用才是 control_store 的 enabled。paused 走池侧入口
        # admin_set_credential_paused(identity, paused)；未落地时回退到 enabled 切换，
        # 保持语义连续（详见 docs/fusion-api.md「凭证 paused 开关」）。
        via_pause = field == "paused"
        if via_pause and not hasattr(gateway, "admin_set_credential_paused"):
            field, value = "enabled", not value
        def apply():
            if selected(identity) is None:
                return error_response(404, "凭证不存在")
            with mutation_lock:
                # The gateway persists under the pool lock before publishing routing state.
                if via_pause:
                    gateway.admin_set_credential_paused(identity, value)
                elif field == "enabled":
                    gateway.admin_set_credential_enabled(identity, value)
                elif field == "auto_checkin":
                    gateway.admin_set_auto_checkin(identity, value)
                elif field == "auto_daily_chat":
                    gateway.admin_set_auto_daily_chat(identity, value)
                else:
                    gateway.admin_set_auto_travel(identity, value)
            event("credential." + field, {"credential": identity, field: value})
            enabled = control.snapshot()["credentials"].get(identity, {}).get("enabled", True)
            if via_pause:
                return JSONResponse({"id": identity, "field": "paused", "paused": value,
                                     "enabled": enabled, "revision": control.snapshot()["revision"]})
            return JSONResponse({"id": identity, field: value, "revision": control.snapshot()["revision"]})
        return await run_in_threadpool(apply)

    def upload(body):
        files = body.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= 100 or type(body.get("replace", False)) is not bool:
            raise ValueError("files 必须包含 1 至 100 项，replace 必须为布尔值")
        total = 0
        prepared = []
        for item in files:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("content"), str):
                raise ValueError("每个文件必须包含 name 和 UTF-8 content")
            name = item["name"]
            if len(name) > 255 or not _valid_name(name):
                raise ValueError("只允许安全的 .info 文件名")
            content = item["content"].encode("utf-8")
            if len(content) > MAX_CREDENTIAL_BYTES:
                raise ValueError("单文件不能超过 1 MiB")
            total += len(content)
            if total > MAX_UPLOAD_BYTES:
                raise ValueError("批量内容不能超过 32 MiB")
            prepared.append((name, content))
        if len({name for name, _ in prepared}) != len(prepared):
            raise ValueError("批量文件名重复")
        results = []
        with mutation_lock:
            directory = gateway.managed_auth_dir().resolve()
            for name, content in prepared:
                try:
                    data = auth_oauth.loads_strict(content)  # Reject nonstandard JSON constants.
                    uid, invalid = auth_oauth.validate_cred_data(data)
                    if invalid or not isinstance(data.get("account") or {}, dict) or type(data["auth"].get("expiresAt", 0)) not in (int, float):
                        raise CredentialFileError("凭据格式无效")
                    if not body.get("replace", False) and (directory / name).exists():
                        results.append({"name": name, "ok": False, "error": "文件已存在，需明确允许替换"})
                        continue
                    # Persist token aliases using official runtime field names.
                    content = json.dumps(auth_oauth.normalize_cred_data(data),
                                         ensure_ascii=False).encode("utf-8")
                    gateway._store_credential(directory, name, content, uid, replace_existing=body.get("replace", False))
                    results.append({"name": name, "ok": True})
                except Exception:
                    results.append({"name": name, "ok": False, "error": "凭据格式、账号冲突或保存目标不符合要求"})
        event("credentials.uploaded", {"count": len(results), "succeeded": sum(item["ok"] for item in results)})
        return results

    @route("POST", "/admin/credentials/upload")
    async def credentials_upload(request):
        # JSON escaping may expand a UTF-8 payload; independently enforce decoded totals.
        body = await _body(request, MAX_UPLOAD_BYTES * 6 + 65536)
        return JSONResponse({"results": await run_in_threadpool(upload, body)})

    def export(body):
        ids = body.get("ids")
        if body.get("confirm") is not True or not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(not isinstance(i, str) for i in ids):
            raise ValueError("导出需 confirm:true 及 1 至 100 个账号指纹；文件包含明文认证信息")
        if len(set(ids)) != len(ids):
            raise ValueError("导出账号指纹重复")
        files, total = [], 0
        directory = gateway.managed_auth_dir().resolve()
        for identity in ids:
            item = selected(identity)
            name = (item.get("name") or item.get("filename")) if item else None
            if not isinstance(name, str) or not _valid_name(name):
                raise ValueError("导出凭证不存在或不在受控目录")
            name, content = read_import_file(directory, name)
            # Recheck identity on the actual bytes, not just a potentially stale inventory.
            if gateway._credential_identity(json.loads(content)) != identity:
                raise ValueError("凭证身份已变化，请刷新后重试")
            total += len(content)
            if total > MAX_UPLOAD_BYTES:
                raise ValueError("导出内容不能超过 32 MiB")
            files.append((name, content))
        event("credentials.exported", {"count": len(files)})
        if len(files) == 1:
            name, content = files[0]
            return Response(content, media_type="application/octet-stream", headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe="")})
        target = io.BytesIO()
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in files:
                archive.writestr(name, content)
        return Response(target.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="credentials.zip"'})

    @route("POST", "/admin/credentials/export")
    async def credentials_export(request):
        return await run_in_threadpool(export, await _body(request))

    @route("GET", "/admin/logs")
    async def logs_get(request):
        params = request.query_params
        kind = params.get("kind", "request")
        if kind not in ("request", "runtime", "admin"):
            raise ValueError("日志 kind 无效")
        try:
            limit = int(params.get("limit", "50"))
        except ValueError:
            raise ValueError("limit 必须为整数") from None
        if not 1 <= limit <= 200:
            raise ValueError("limit 必须为 1 至 200")
        filters = {key: params[key] for key in ("model", "credential", "profile", "status", "search") if key in params}
        if any(len(value) > 256 for value in filters.values()) or len(params.get("cursor", "")) > 2048:
            raise ValueError("日志筛选参数过长")
        result = await run_in_threadpool(audit.list_records, kind, limit, params.get("cursor"), **filters)
        if result.get("degraded"):
            return error_response(503, "日志暂时无法读取，请检查审计存储状态")
        return JSONResponse(result)

    @route("GET", "/admin/logs/{id}")
    async def logs_detail(request):
        result = await run_in_threadpool(audit.get_request, request.path_params["id"])
        if result is None and (await run_in_threadpool(audit.storage)).get("degraded"):
            return error_response(503, "请求明细暂时无法确认，请检查审计存储状态")
        return JSONResponse(result) if result is not None else error_response(404, "请求明细不存在或已清理")

    @route("POST", "/admin/logs/clear")
    async def logs_clear(request):
        body = await _body(request, 8192)
        scope = body.get("scope")
        if scope not in ("details", "all"):
            raise ValueError("清理范围必须为 details 或 all")
        if scope == "all" and (body.get("confirmation") != CLEAR_CONFIRMATION or not auth.check_key(body.get("api_key"))):
            return error_response(403, "全部清理需要确认文本及当前 API key")
        result = await run_in_threadpool(audit.clear, scope)
        if isinstance(result, dict) and result.get("ok") is False:
            return error_response(503, "日志清理未完成，请检查审计存储状态")
        return JSONResponse(result)

    @route("GET", "/admin/dashboard")
    async def dashboard_get(request):
        try:
            days = int(request.query_params.get("days", "7"))
        except ValueError:
            raise ValueError("days 必须为 1、7、30 或 90") from None
        if days not in (1, 7, 30, 90):
            raise ValueError("days 必须为 1、7、30 或 90")
        granularity = request.query_params.get("granularity", "auto")
        if granularity not in ("auto", "hour", "day"):
            raise ValueError("granularity 必须为 auto、hour 或 day")
        def build_dashboard():
            result = audit.dashboard(days, granularity=granularity)
            if result.get("degraded"):
                return error_response(503, "统计暂时无法读取，不能确认当前数值；请检查审计存储状态")
            rows = [_public_credential(item) for item in inventory()]
            result.setdefault("health", {"credentials": rows})
            result.setdefault("storage", audit.storage())
            result.setdefault("generated_at", time.time())
            result.setdefault("range", {"days": days})
            result["official_credits"] = {row["id"]: {"credits": row.get("credits"), "name": row.get("name"),
                                                        "fetched_at": (row.get("credits") or {}).get("fetched_at")}
                                          for row in rows}
            return result
        result = await run_in_threadpool(build_dashboard)
        return result if isinstance(result, Response) else JSONResponse(result)

    # -- 融合层：分位数 / 维度切分 / 生成速率与积分到期视图 ----------------

    def _stats_days(request):
        """Shared window validation for the fusion statistics endpoints."""
        days = request.query_params.get("days", "7")
        try:
            days = int(str(days).strip())
        except ValueError:
            raise ValueError("days 必须为 1、7、30 或 90") from None
        if days not in (1, 7, 30, 90):
            raise ValueError("days 必须为 1、7、30 或 90")
        return days

    def _dimension_query(dimension, key, days, granularity):
        """Run a dimension query, mapping an unavailable backend to a degraded marker."""
        backend = getattr(audit, "dimension_query", None)
        if backend is None:
            return {"degraded": True}
        try:
            return backend(dimension, key, days, granularity)
        except Exception:
            # The store reports degradation itself; a hard fault degrades the same way.
            return {"degraded": True}

    @route("GET", "/admin/stats/summary")
    async def stats_summary(request):
        days = _stats_days(request)

        def build():
            result = _dimension_query("global", None, days, "day")
            if result.get("degraded"):
                return error_response(503, "统计暂时无法读取，不能确认当前数值；请检查审计存储状态")
            summary = stats_view(result.get("summary") or {})
            return JSONResponse({"generated_at": time.time(), "range": result.get("range"),
                                 "summary": summary, "degraded": False})
        return await run_in_threadpool(build)

    @route("GET", "/admin/stats/series")
    async def stats_series(request):
        days = _stats_days(request)
        granularity = request.query_params.get("granularity", "auto")
        if granularity not in ("auto", "hour", "day"):
            raise ValueError("granularity 必须为 auto、hour 或 day")
        dimension = request.query_params.get("dimension", "global")
        if dimension not in ("global", "model", "profile", "credential"):
            raise ValueError("dimension 必须为 global、model、profile 或 credential")
        key = request.query_params.get("key")
        if dimension == "global":
            if key not in (None, ""):
                raise ValueError("global 维度不接受 key")
            key = None
        elif not key:
            raise ValueError("非 global 维度必须提供 key")

        def build():
            result = _dimension_query(dimension, key, days, granularity)
            if result.get("degraded"):
                return error_response(503, "统计暂时无法读取，不能确认当前数值；请检查审计存储状态")
            series = [dict(row, **stats_view(row)) for row in (result.get("series") or [])]
            return JSONResponse({"generated_at": time.time(), "range": result.get("range"),
                                 "series": series,
                                 "summary": stats_view(result.get("summary") or {}),
                                 "degraded": False})
        return await run_in_threadpool(build)

    @route("GET", "/admin/stats/dimensions")
    async def stats_dimensions(request):
        dimension = request.query_params.get("dimension")
        if dimension not in ("model", "profile", "credential"):
            raise ValueError("dimension 必须为 model、profile 或 credential")
        days = _stats_days(request)
        # The credential list mirrors /admin/credentials so the picker can reuse labels.
        rows = {str(item.get("id")): item for item in inventory()} if dimension == "credential" else {}

        def build():
            backend = getattr(audit, "dimension_keys", None)
            if backend is None:
                return error_response(503, "统计暂时无法读取，不能确认当前数值；请检查审计存储状态")
            try:
                result = backend(dimension, days)
            except Exception:
                return error_response(503, "统计暂时无法读取，不能确认当前数值；请检查审计存储状态")
            items = []
            for key, payload in (result.get("keys") or {}).items():
                view = stats_view(payload)
                view["key"] = key
                if dimension == "credential":
                    row = rows.get(key) or {}
                    view["label"] = Path(str(row.get("name") or "")).name or None
                    view["profile"] = row.get("profile")
                else:
                    view["label"] = None
                    view["profile"] = None
                items.append(view)
            items.sort(key=lambda item: item.get("requests") or 0, reverse=True)
            return JSONResponse({"generated_at": time.time(), "dimension": dimension,
                                 "days": days, "items": items[:200],
                                 "degraded": bool(result.get("degraded"))})
        return await run_in_threadpool(build)

    @route("GET", "/admin/credits/expiry")
    async def credits_expiry(request):
        days = int_param(request, "days", 30, 1, 90)
        burn_days = int_param(request, "burn_days", 7, 1, 30)
        threshold_days = config.get("alert_credits_expiry_days")
        try:
            threshold_days = int(threshold_days)
        except (TypeError, ValueError):
            threshold_days = 3

        def build():
            now = time.time()
            window_end = now + days * 86400
            rows = inventory()
            burn = {}
            backend = getattr(audit, "dimension_query", None)
            burn_known = backend is not None
            if backend is not None:
                for row in rows:
                    identity = str(row.get("id") or "")
                    if not identity:
                        continue
                    try:
                        result = backend("credential", identity, burn_days, "day")
                    except Exception:
                        result = {"degraded": True}
                    if result.get("degraded"):
                        burn_known = False
                        break
                    burn[identity] = result.get("summary") or {}
            items = []
            for row in rows:
                credits = row.get("credits") if isinstance(row.get("credits"), dict) else {}
                segments = [segment for segment in (credits.get("segments") or [])
                            if isinstance(segment, dict) and float(segment.get("remaining") or 0) > 0]
                if not segments:
                    continue
                segments.sort(key=lambda segment: float(segment.get("expires_at") or 0))
                identity = str(row.get("id") or "")
                remaining = round(sum(float(segment.get("remaining") or 0) for segment in segments), 2)
                soonest = segments[0].get("expires_at")
                days_remaining = None
                if isinstance(soonest, (int, float)) and soonest > 0:
                    days_remaining = max(0.0, (float(soonest) - now) / 86400.0)
                summary = burn.get(identity) or {}
                credit_used = summary.get("credit")
                daily_burn = None
                if credit_used is not None:
                    daily_burn = round(float(credit_used) / float(burn_days), 2)
                projected = None
                if daily_burn and daily_burn > 0 and remaining is not None:
                    projected = round(remaining / daily_burn, 1)
                shown = []
                for segment in segments[:32]:
                    expiry = segment.get("expires_at")
                    shown.append({"remaining": round(float(segment.get("remaining") or 0), 2),
                                  "total": round(float(segment.get("total") or 0), 2),
                                  "expires_at": float(expiry) if isinstance(expiry, (int, float)) else None,
                                  "source": str(segment.get("source") or "积分")[:120],
                                  "package_code": str(segment.get("package_code") or "")[:120],
                                  "in_window": bool(isinstance(expiry, (int, float)) and expiry <= window_end)})
                items.append({"account_id": identity,
                              "name": Path(str(row.get("name") or "")).name or None,
                              "profile": row.get("profile"),
                              "remaining_credits": remaining,
                              "daily_burn": daily_burn,
                              "soonest_expiry": float(soonest) if isinstance(soonest, (int, float)) else None,
                              "days_remaining": round(days_remaining, 2) if days_remaining is not None else None,
                              "projected_exhaustion_days": projected,
                              "urgent": bool(days_remaining is not None and days_remaining < threshold_days),
                              "segments": shown})
            items.sort(key=lambda item: (item["days_remaining"] is None, item["days_remaining"] or 0))
            expiring = [item for item in items
                        if any(segment.get("in_window") for segment in item["segments"])]
            expiring_credits = round(sum(
                segment["remaining"] for item in expiring for segment in item["segments"] if segment.get("in_window")), 2)
            total_credits = round(sum(item["remaining_credits"] or 0 for item in items), 2)
            daily_total = None
            if burn_known:
                used = sum((burn.get(str(item["account_id"])) or {}).get("credit") or 0 for item in items)
                daily_total = round(float(used) / float(burn_days), 2) if used else 0.0
            return JSONResponse({"generated_at": now, "threshold_days": threshold_days,
                                 "burn_window_days": burn_days,
                                 "summary": {"expiring_accounts": len(expiring),
                                             "expiring_credits": expiring_credits,
                                             "urgent_accounts": sum(1 for item in items if item["urgent"]),
                                             "total_credits": total_credits,
                                             "daily_burn": daily_total,
                                             "daily_burn_known": burn_known},
                                 "items": items})
        return await run_in_threadpool(build)

    return auth
