import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtendedFeatures } from "../core/extended.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jervis-extended-"));
const allowed = path.join(directory, "allowed");
fs.mkdirSync(allowed);
const guard = (value) => {
  const resolved = path.resolve(value);
  const relative = path.relative(allowed, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Verifier path escaped its temporary root.");
  return resolved;
};
const extended = new ExtendedFeatures(directory, guard);

try {
  const text = path.join(allowed, "office-source.txt");
  const pdf = path.join(allowed, "office-output.pdf");
  fs.writeFileSync(text, "JERVIS Office conversion verification");
  await extended.documents({ operation: "officeToPdf", path: text, output: pdf }, [allowed]);

  const backup = path.join(allowed, "jervis-backup.zip");
  fs.writeFileSync(path.join(directory, "api.txt"), "must-not-be-backed-up");
  fs.writeFileSync(path.join(directory, "personal-data.json"), "{}");
  await extended.fileManagement({ operation: "backup", output: backup, confirm: true }, [allowed]);

  const system = JSON.parse(await extended.diagnostics({ operation: "system" }));
  const color = JSON.parse(await extended.creative({ operation: "screenColor" }, [allowed]));
  const ports = JSON.parse(await extended.security({ operation: "portScan", host: "127.0.0.1", ports: [8787] }, [allowed]));
  console.log(JSON.stringify({
    officePdf: fs.readFileSync(pdf).subarray(0, 4).toString() === "%PDF",
    redactedBackup: fs.existsSync(backup) && fs.statSync(backup).size > 0,
    windows: Boolean(system.Caption),
    screenColor: /^#[0-9A-F]{6}$/.test(color.hex),
    localPortScanCompleted: ports.scanned === 1,
  }, null, 2));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
