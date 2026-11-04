import type { ButtonHTMLAttributes, ReactElement } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./Button.module.scss";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading glyph: a name renders the shared Icon at control size, an element is rendered as given. */
  icon?: IconName | ReactElement;
  /** Fill the container (drawer forms, card actions). */
  block?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A button whose label cannot leave the box it was given.
 *
 * The two structural properties are the point: `max-width: 100%` plus `overflow-wrap:
 * anywhere` mean a long label wraps inside the button instead of stretching it past the
 * card and getting clipped by the panel (P1-3: a 316px trigger inside a 157px slot lost
 * its timestamp with no ellipsis and no way to read it).
 */
export function Button({
  variant = "default",
  size = "md",
  icon,
  block = false,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={className ? `${s.button} ${className}` : s.button}
      data-variant={variant}
      data-size={size}
      data-block={block ? "true" : undefined}
      {...rest}
    >
      {typeof icon === "string" ? <Icon name={icon} size="sm" /> : icon}
      {children === undefined ? null : <span className={s.label}>{children}</span>}
    </button>
  );
}
