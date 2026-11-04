import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { popoverHost, usePopover } from "../popover";
import { Icon } from "./Icon";
import s from "./Select.module.scss";

type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };
type Choice = { value: string; label: ReactNode; disabled: boolean };

/** Read <option> children the way a native select does; the text stands in for a missing value. */
function choicesOf(children: ReactNode): Choice[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<OptionProps>(child) && child.type === "option"
      ? [
          {
            value:
              child.props.value !== undefined
                ? String(child.props.value)
                : typeof child.props.children === "string"
                  ? child.props.children
                  : "",
            label: child.props.children,
            disabled: child.props.disabled === true,
          },
        ]
      : [],
  );
}

export type SelectProps = {
  value: string | number;
  onChange: (value: string) => void;
  /** `<option>` children, written exactly like a native select. */
  children: ReactNode;
  /**
   * Accessible name, in either spelling. A button is labelable, so a wrapping `<label>` also
   * names it — that is how the pre-migration call sites have always worked — but a Select
   * standing on its own belongs to one of these two props.
   */
  label?: string;
  "aria-label"?: string;
  disabled?: boolean;
  id?: string;
  title?: string;
  className?: string;
};

/**
 * A select-only combobox (WAI-ARIA pattern): a button trigger plus a listbox popover.
 *
 * The popover is placed by the shared algorithm in popover.ts, so it flips above the
 * trigger near the bottom of the viewport and joins an open dialog's top layer instead of
 * being captured by a panel's transformed ancestor.
 */
export function Select(props: SelectProps) {
  const { value, onChange, children, disabled = false, id, title, className = "" } = props;
  const label = props.label ?? props["aria-label"] ?? "";
  const choices = choicesOf(children);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const generated = useId();
  const listId = `${id ?? generated}-listbox`;
  const close = useCallback(() => setOpen(false), []);
  const placement = usePopover(open, close, trigger, list, "start");
  const current = choices.findIndex((choice) => choice.value === String(value));
  const enabled = choices.flatMap((choice, index) => (choice.disabled ? [] : [index]));

  useEffect(() => {
    if (open)
      list.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setActive(current >= 0 ? current : (enabled[0] ?? 0));
    setOpen(true);
  };
  const pick = (index: number) => {
    const choice = choices[index];
    if (!choice || choice.disabled) return;
    setOpen(false);
    if (choice.value !== String(value)) onChange(choice.value);
  };
  const step = (direction: 1 | -1) => {
    const position = enabled.indexOf(active);
    const next = enabled[Math.min(enabled.length - 1, Math.max(0, position + direction))];
    if (next !== undefined) setActive(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) step(event.key === "ArrowDown" ? 1 : -1);
      else show();
    } else if ((event.key === "Home" || event.key === "End") && open) {
      event.preventDefault();
      setActive((event.key === "Home" ? enabled[0] : enabled.at(-1)) ?? 0);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) pick(active);
      else show();
    } else if (event.key === "Escape" && open) {
      // Close the list only: the drawer around it keeps its own Escape handling.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={label}
        title={title}
        disabled={disabled}
        className={className ? `${s.trigger} ${className}` : s.trigger}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className={s.value}>{choices[current]?.label ?? "—"}</span>
        <Icon name="chevron" size="sm" className={s.chevron} />
      </button>
      {open &&
        createPortal(
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            className={s.list}
            style={
              placement
                ? { top: placement.top, left: placement.left, minWidth: placement.minWidth }
                : { visibility: "hidden" }
            }
          >
            {choices.map((choice, index) => (
              <li
                key={choice.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                aria-disabled={choice.disabled || undefined}
                data-index={index}
                data-value={choice.value}
                className={s.option}
                data-active={index === active ? "true" : undefined}
                onMouseEnter={() => !choice.disabled && setActive(index)}
                // Keep focus on the trigger so the keyboard keeps working after a pointer pick.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)}
              >
                {choice.label}
              </li>
            ))}
          </ul>,
          popoverHost(trigger.current),
        )}
    </>
  );
}
