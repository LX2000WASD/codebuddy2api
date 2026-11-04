import type { TextareaHTMLAttributes } from "react";
import s from "./Textarea.module.scss";

export type TextareaProps = {
  /** Paint the field as invalid; also sets aria-invalid so the state is announced. */
  invalid?: boolean;
  /** Monospace, for pasted JSON or ids. */
  mono?: boolean;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({
  invalid = false,
  mono = false,
  className = "",
  ...rest
}: TextareaProps) {
  return (
    <textarea
      className={className ? `${s.textarea} ${className}` : s.textarea}
      data-mono={mono ? "true" : undefined}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}
