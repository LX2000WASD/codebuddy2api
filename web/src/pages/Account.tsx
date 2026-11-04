import { useEffect, useState } from "react";
import { api, errorMessage, object, useSession } from "../api";
import { t as translate, useT } from "../i18n";
import {
  Badge,
  Button,
  Cluster,
  ErrorNotice,
  Field,
  Input,
  Panel,
  ResourceState,
  Stack,
  notify,
} from "../ui";
import s from "./Account.module.scss";

type Account = {
  username: string;
  password_source: string;
  bootstrap: boolean;
  changed_at: number;
};

function normalize(value: unknown): Account {
  const data = object(value, translate("account.title"));
  if (
    typeof data.username !== "string" ||
    typeof data.password_source !== "string" ||
    typeof data.bootstrap !== "boolean" ||
    typeof data.changed_at !== "number"
  )
    throw new Error(translate("account.invalidResponse"));
  return {
    username: data.username,
    password_source: data.password_source,
    bootstrap: data.bootstrap,
    changed_at: data.changed_at,
  };
}

export function AccountPanel() {
  const t = useT();
  const [account, setAccount] = useState<Account | null>(null);
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    void api
      .get("/account")
      .then((response) => {
        const data = normalize(response.data);
        setAccount(data);
        setUsername(data.username);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const changed = account !== null && (username !== account.username || newPassword.length > 0);
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!account) return;
    if (newPassword !== confirmation) {
      setError(t("account.mismatch"));
      return;
    }
    const body: Record<string, string> = { current_password: currentPassword };
    if (username !== account.username) body.username = username;
    if (newPassword) body.new_password = newPassword;
    setBusy(true);
    setError(null);
    void api
      .put("/account", body)
      .then((response) => {
        const data = object(response.data, t("account.title"));
        if (typeof data.username !== "string" || typeof data.csrf_token !== "string")
          throw new Error(t("account.missingCsrf"));
        useSession.setState({ csrf: data.csrf_token, bootstrap: data.bootstrap === true });
        setAccount({ ...account, username: data.username, bootstrap: data.bootstrap === true });
        setUsername(data.username);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmation("");
        notify({ key: "account-saved", tone: "good", title: t("account.saved") });
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  const revokeAll = () => {
    if (!window.confirm(t("account.revokeConfirm"))) return;
    setBusy(true);
    setError(null);
    void api
      .delete("/sessions")
      .then(() =>
        useSession.setState({
          status: "anonymous",
          csrf: null,
          bootstrap: false,
          error: null,
        }),
      )
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <ResourceState loading={loading} error={error && !account ? error : null} reload={load} />
      {account && (
        <Stack gap="4">
          <Panel
            title={t("account.title")}
            action={
              <Badge tone={account.bootstrap ? "warn" : "good"}>
                {account.bootstrap ? t("account.bootstrapInitial") : t("account.bootstrapChanged")}
              </Badge>
            }
          >
            <form className={s.form} onSubmit={save}>
              <Field label={t("login.username")}>
                <Input
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  pattern="[A-Za-z0-9_.-]{1,32}"
                  required
                />
              </Field>
              <Field label={t("common.currentPassword")}>
                <Input
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                />
              </Field>
              <Field label={t("account.newPassword")}>
                <Input
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={8}
                  maxLength={128}
                  placeholder={t("account.passwordHint")}
                />
              </Field>
              <Field label={t("account.confirmPassword")}>
                <Input
                  name="confirm-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  minLength={newPassword ? 8 : undefined}
                  maxLength={128}
                  placeholder={t("account.passwordHint")}
                />
              </Field>
              <ErrorNotice message={error} />
              <Cluster>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !changed || !currentPassword}
                  aria-busy={busy}
                >
                  {busy ? t("account.saving") : t("account.save")}
                </Button>
              </Cluster>
            </form>
          </Panel>
          <Panel title={t("account.sessionsTitle")} hint={t("account.sessionsHint")}>
            <Cluster>
              <Button variant="danger" type="button" disabled={busy} onClick={revokeAll}>
                {t("account.revokeAll")}
              </Button>
            </Cluster>
          </Panel>
        </Stack>
      )}
    </>
  );
}
