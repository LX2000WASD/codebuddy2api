import type { InputHTMLAttributes } from "react";
import s from "./Input.module.scss";

export type InputProps = {
  /** Paint the field as invalid; also sets aria-invalid so the state is announced. */
  invalid?: boolean;
  /** Monospace, for ids, keys and filter values that are read character by character. */
  mono?: boolean;
} & InputHTMLAttributes<HTMLInputElement>;

export function Input({ invalid = false, mono = false, className = "", ...rest }: InputProps) {
  return (
    <input
      className={className ? `${s.input} ${className}` : s.input}
      data-mono={mono ? "true" : undefined}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}
