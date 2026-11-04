import s from "./Switch.module.scss";

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * Accessible name. Required: the visible label usually lives in the surrounding Field
   * or text, and a bare switch announces as "on/off" with no subject.
   */
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * A native checkbox with `role="switch"`: keyboard, form and screen-reader behaviour come
 * from the platform, and only the paint is ours.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className = "",
}: SwitchProps) {
  return (
    <span className={className ? `${s.switch} ${className}` : s.switch}>
      <input
        id={id}
        className={s.input}
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={s.track} aria-hidden="true" />
    </span>
  );
}
