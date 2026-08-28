import { useEffect, useState } from "react";
import { CoreVisual } from "./App.jsx";

export default function OrbOverlay() {
  const [orb, setOrb] = useState({ state: "awake", level: 0.25 });

  useEffect(() => window.jervisDesktop?.onOrbState((next) => setOrb({
    state: next?.state || "awake",
    level: Number(next?.level) || 0,
  })), []);

  return (
    <main className="orb-overlay">
      <CoreVisual
        state={orb.state}
        level={orb.level}
        onClick={() => window.jervisDesktop?.openMainWindow()}
      />
    </main>
  );
}
