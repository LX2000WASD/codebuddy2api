import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";
import { clearSnapshots } from "./api";
import { resetGlobalClock } from "./hooks";
window.scrollTo = vi.fn();
if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
afterEach(() => {
  cleanup();
  // Module-level state outlives a test file's cases: without this the shared
  // snapshot layer hands test 2 the payload test 1 mocked, and the shared 1 Hz
  // clock keeps a timer alive across files. Both are process-wide by design, so
  // the reset belongs in the same place for every test.
  clearSnapshots();
  resetGlobalClock();
});
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
