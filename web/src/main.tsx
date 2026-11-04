import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
// Document-level defaults (typography, page colour, form-control inheritance). Imported
// once here so every route — including the login page and the 404 — inherits them.
import "./design/globals.scss";
import { initializeAppearance } from "./appearance";
import App from "./App";

// Apply the stored theme before the first paint. It used to run in an effect inside the
// appearance control, which on a narrow header only mounts once its menu opens — so a
// dark-mode user on a phone got the light theme until they poked that menu.
initializeAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
