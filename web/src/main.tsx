import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
// Document-level defaults (typography, page colour, form-control inheritance). Imported
// once here so every route — including the login page and the 404 — inherits them.
import "./design/globals.scss";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
