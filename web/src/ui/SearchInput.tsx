import { useT } from "../i18n";
import { Icon } from "./Icon";
import s from "./SearchInput.module.scss";

export type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the field ("搜索凭证"). */
  "aria-label": string;
  placeholder?: string;
  className?: string;
  id?: string;
};

/** A recessed search field: leading magnifier, the input, and a clear button once there is text. */
export function SearchInput({ value, onChange, className = "", id, ...rest }: SearchInputProps) {
  const t = useT();
  return (
    <span className={className ? `${s.search} ${className}` : s.search}>
      <Icon name="search" size="sm" className={s.icon} />
      <input
        id={id}
        className={s.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className={s.clear}
          aria-label={t("common.clearSearch")}
          onClick={() => onChange("")}
        >
          <Icon name="close" size="sm" />
        </button>
      ) : null}
    </span>
  );
}
