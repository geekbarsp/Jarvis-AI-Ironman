import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import OrbOverlay from "./OrbOverlay.jsx";
import "./styles.css";

const orbMode = new URLSearchParams(window.location.search).has("orb");
document.documentElement.classList.toggle("orb-mode", orbMode);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {orbMode ? <OrbOverlay /> : <App />}
  </StrictMode>,
);
