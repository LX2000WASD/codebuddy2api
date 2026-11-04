import { useT } from "../i18n";
import { ErrorNotice, LoadingLine } from "./Feedback";

export type ResourceStateProps = {
  /** The page is fetching; a status line is shown. */
  loading: boolean;
  /** The page's last load error; nothing renders when it is empty. */
  error: string | null;
  reload: () => void;
};

/**
 * "Fetching" and "failed" for a page whose body renders from one resource: a status line
 * while it loads, then the error with the retry that belongs to it.
 *
 * It is not a spinner *over* content — a reload that fails keeps the previous payload on
 * screen (useResource holds it), and covering that with a spinner would hide data that is
 * still useful.
 */
export function ResourceState({ loading, error, reload }: ResourceStateProps) {
  const t = useT();
  return (
    <>
      {loading && <LoadingLine label={t("common.loading")} />}
      <ErrorNotice message={error} retry={{ label: t("common.retry"), onClick: reload }} />
    </>
  );
}
