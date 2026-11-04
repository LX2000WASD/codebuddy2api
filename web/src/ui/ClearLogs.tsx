import { useState } from "react";
import { api, errorMessage, object } from "../api";
import { useT } from "../i18n";
import s from "./ClearLogs.module.scss";
import { Button } from "./Button";
import { ErrorNotice } from "./Feedback";
import { Field } from "./Field";
import { Icon } from "./Icon";
import { Input } from "./Input";
import { Drawer } from "./Overlay";
import { Select } from "./Select";

export const CLEAR_CONFIRMATION = "清空全部日志与统计";

export type ClearLogsProps = {
  onClose: () => void;
  onDone: () => void;
};

/**
 * The two-stage "clear the audit trail" form: details only, or everything with the typed
 * confirmation and the current password. The logic is the one from components.tsx, unchanged;
 * only the markup is now primitives.
 */
export function ClearLogs({ onClose, onDone }: ClearLogsProps) {
  const t = useT();
  const [scope, setScope] = useState<"details" | "all">("details");
  const [confirmation, setConfirmation] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Drawer
      title={t("logs.clear")}
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      dismissDisabled={busy}
    >
      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          const password = currentPassword;
          setCurrentPassword("");
          void api
            .post("/logs/clear", {
              scope,
              confirmation: scope === "all" ? confirmation : "",
              ...(scope === "all" ? { password } : {}),
            })
            .then((response) => {
              if (object(response.data).ok !== true) throw new Error(t("logs.clear.unconfirmed"));
              onDone();
              onClose();
            })
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <Field label={t("logs.clear.scope")}>
          <Select
            label={t("logs.clear.scope")}
            value={scope}
            onChange={(value) => {
              setScope(value as "details" | "all");
              setConfirmation("");
              setCurrentPassword("");
            }}
          >
            <option value="details">{t("logs.clear.detailsOnly")}</option>
            <option value="all">{t("logs.clear.everything")}</option>
          </Select>
        </Field>
        <div className={s.warning}>
          <Icon name="alert" size="sm" />
          <div className={s.warningText}>
            <strong>{scope === "all" ? CLEAR_CONFIRMATION : t("logs.clear.detailsStrong")}</strong>
            <p>{scope === "all" ? t("logs.clear.allWarning") : t("logs.clear.detailsWarning")}</p>
          </div>
        </div>
        {scope === "all" && (
          <>
            <Field label={`输入“${CLEAR_CONFIRMATION}”`}>
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label={t("common.currentPassword")}>
              <Input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          </>
        )}
        <ErrorNotice message={error} />
        <Button
          type="submit"
          variant="danger"
          disabled={
            busy || (scope === "all" && (confirmation !== CLEAR_CONFIRMATION || !currentPassword))
          }
        >
          {busy ? t("logs.clear.busy") : t("logs.clear.confirm")}
        </Button>
      </form>
    </Drawer>
  );
}
