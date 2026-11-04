import type { ButtonHTMLAttributes, ReactElement } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./IconButton.module.scss";

export type IconButtonProps = {
  /** A glyph name, or an element for a glyph this set does not carry (a spinning refresh). */
  icon: IconName | ReactElement;
  /**
   * Accessible name, also used as the tooltip. Required by the type: a glyph alone names
   * nothing, and every icon button in the console has to be announceable.
   */
  label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title" | "children">;

export function IconButton({
  icon,
  label,
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={className ? `${s.iconButton} ${className}` : s.iconButton}
      {...rest}
    >
      {typeof icon === "string" ? <Icon name={icon} /> : icon}
    </button>
  );
}
