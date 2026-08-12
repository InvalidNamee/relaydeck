import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RemoteBrowser } from "@relaydeck/client-ui";
import "@relaydeck/client-ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <RemoteBrowser />
  </StrictMode>,
);
