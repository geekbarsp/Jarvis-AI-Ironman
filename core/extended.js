import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";

const MAX_TEXT = 20000;

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function powershell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout.trim().slice(0, MAX_TEXT)) : reject(new Error(stderr.trim() || `Windows helper failed (${code}).`)));
  });
}

function run(command, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(command)} timed out.`)); }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim().slice(0, MAX_TEXT));
      else reject(new Error(stderr.trim() || `${path.basename(command)} failed (${code}).`));
    });
  });
}

function requireConfirm(args, action) {
  if (args.confirm !== true) throw new Error(`${action} requires confirm=true after the user explicitly requests it.`);
}

function required(value, label) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function textSource(args, allowedPath, roots) {
  if (args.text !== undefined) return String(args.text).slice(0, 200000);
  const file = allowedPath(args.path, roots);
  return fs.readFileSync(file, "utf8").slice(0, 200000);
}

function wrapText(text, max = 88) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r/g, "").split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (`${line} ${word}`.trim().length > max && line) { lines.push(line); line = word; }
      else line = `${line} ${word}`.trim();
    }
    lines.push(line);
  }
  return lines;
}

function titleCase(value) {
  return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const CATALOGUE = Object.freeze({
  native: {
    voice: ["wake listening", "selected microphone", "dictation", "local transcription", "Fish Audio speech"],
    intelligence: ["Ollama", "Groq", "Gemini", "OpenAI", "planning", "memory", "tool routing"],
    productivity: ["reminders", "notes", "contacts", "clipboard", "email and WhatsApp links", "app and website control", "adaptive workspace capture and restore"],
    files: ["safe search", "recent and large files", "duplicates", "ZIP compression and extraction", "folder size"],
    documents: ["word count", "text cleanup", "email templates", "text to PDF", "merge/split/rotate/watermark PDFs", "images to PDF"],
    wellness: ["water", "exercise", "sleep", "mood", "stress", "medication", "BMI", "calorie needs"],
    learning: ["flashcards", "quiz decks", "dictionary and research through web tools", "translation through AI providers"],
    creative: ["QR codes", "color palettes", "image conversion", "screenshots", "AI-assisted writing and code"],
    security: ["AES-256-GCM file vault", "URL risk checks", "process inspection", "confirmed power and file mutations"],
    diagnostics: ["system", "battery", "disk", "network", "USB", "startup apps", "installed apps", "Python packages"],
    phone: ["ADB connection", "device details", "package listing", "battery", "notifications on explicit request"],
  },
  adapters: ["MCP smart-home/services", "browser-based streaming/radio/podcasts", "mail client composition", "Phone Link URIs"],
  preservedReference: "legacy_runtime/vendor",
});

export class ExtendedFeatures {
  constructor(dataDir, allowedPath) {
    this.dataDir = dataDir;
    this.allowedPath = allowedPath;
    this.file = path.join(dataDir, "extended-data.json");
    this.data = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { health: data.health || [], flashcards: data.flashcards || [], calendar: data.calendar || [] };
    } catch { return { health: [], flashcards: [], calendar: [] }; }
  }

  save() { atomicJson(this.file, this.data); }

  catalogue(args = {}) {
    const query = String(args.query || "").toLowerCase();
    if (!query) return JSON.stringify(CATALOGUE, null, 2);
    const matches = [];
    for (const [group, features] of Object.entries(CATALOGUE.native)) {
      for (const feature of features) if (`${group} ${feature}`.toLowerCase().includes(query)) matches.push({ group, feature });
    }
    return JSON.stringify(matches.length ? matches : { message: "No direct match. Search the main tool catalogue or configure an MCP integration.", catalogue: CATALOGUE }, null, 2);
  }

  health(args) {
    const operation = args.operation || "summary";
    if (operation === "log") {
      const type = required(args.type, "Health entry type").toLowerCase();
      const item = { id: crypto.randomUUID(), type, value: args.value ?? null, unit: String(args.unit || ""), note: String(args.note || "").slice(0, 2000), ts: new Date(args.at || Date.now()).toISOString() };
      this.data.health.push(item); this.save(); return JSON.stringify(item, null, 2);
    }
    if (operation === "list" || operation === "summary") {
      const from = args.from ? new Date(args.from).getTime() : Date.now() - 7 * 86400000;
      const entries = this.data.health.filter((item) => new Date(item.ts).getTime() >= from && (!args.type || item.type === String(args.type).toLowerCase()));
      if (operation === "list") return JSON.stringify(entries.slice(-200), null, 2);
      const totals = {};
      for (const item of entries) {
        totals[item.type] ||= { entries: 0, numericTotal: 0, unit: item.unit };
        totals[item.type].entries += 1;
        if (Number.isFinite(Number(item.value))) totals[item.type].numericTotal += Number(item.value);
      }
      return JSON.stringify({ from: new Date(from).toISOString(), totals, recent: entries.slice(-20) }, null, 2);
    }
    if (operation === "bmi") {
      const kilograms = Number(args.weightKg); const meters = Number(args.heightCm) / 100;
      if (!(kilograms > 0 && meters > 0)) throw new Error("Positive weightKg and heightCm are required.");
      const bmi = kilograms / (meters * meters);
      const category = bmi < 18.5 ? "underweight" : bmi < 25 ? "healthy range" : bmi < 30 ? "overweight" : "obesity range";
      return JSON.stringify({ bmi: +bmi.toFixed(1), category, note: "BMI is a screening measure, not a diagnosis." });
    }
    if (operation === "calorieNeeds") {
      const weight = Number(args.weightKg); const height = Number(args.heightCm); const age = Number(args.age);
      if (!(weight > 0 && height > 0 && age > 0)) throw new Error("weightKg, heightCm, and age are required.");
      const base = 10 * weight + 6.25 * height - 5 * age + (String(args.sex).toLowerCase() === "female" ? -161 : 5);
      const factors = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9 };
      const factor = factors[args.activity] || factors.moderate;
      return JSON.stringify({ estimatedDailyCalories: Math.round(base * factor), method: "Mifflin-St Jeor", note: "This is a general estimate, not medical advice." });
    }
    if (operation === "delete") {
      requireConfirm(args, "Deleting a health entry");
      const index = this.data.health.findIndex((item) => item.id === args.id);
      if (index < 0) return "No health entry matched that ID.";
      this.data.health.splice(index, 1); this.save(); return "Health entry deleted.";
    }
    throw new Error("Unknown health operation.");
  }

  study(args) {
    const operation = args.operation || "list";
    if (operation === "add") {
      const card = { id: crypto.randomUUID(), deck: String(args.deck || "default"), question: required(args.question, "Question").slice(0, 2000), answer: required(args.answer, "Answer").slice(0, 5000), createdAt: new Date().toISOString() };
      this.data.flashcards.push(card); this.save(); return JSON.stringify(card, null, 2);
    }
    if (operation === "list") return JSON.stringify(this.data.flashcards.filter((card) => !args.deck || card.deck === args.deck), null, 2);
    if (operation === "quiz") {
      const cards = this.data.flashcards.filter((card) => !args.deck || card.deck === args.deck);
      if (!cards.length) return "No flashcards are available in that deck.";
      const count = Math.min(Number(args.count) || 5, cards.length);
      const selected = [...cards].sort(() => Math.random() - 0.5).slice(0, count);
      return JSON.stringify({ deck: args.deck || "all", questions: selected.map(({ id, question }) => ({ id, question })), answerKey: selected.map(({ id, answer }) => ({ id, answer })) }, null, 2);
    }
    if (operation === "delete") {
      requireConfirm(args, "Deleting a flashcard");
      const index = this.data.flashcards.findIndex((card) => card.id === args.id);
      if (index < 0) return "No flashcard matched that ID.";
      this.data.flashcards.splice(index, 1); this.save(); return "Flashcard deleted.";
    }
    throw new Error("Unknown study operation.");
  }

  calendar(args) {
    const operation = args.operation || "list";
    if (operation === "add") {
      const start = new Date(args.start);
      if (!Number.isFinite(start.getTime())) throw new Error("A valid event start date/time is required.");
      const end = args.end ? new Date(args.end) : new Date(start.getTime() + 3600000);
      if (!Number.isFinite(end.getTime()) || end <= start) throw new Error("Event end must be after its start.");
      const event = { id: crypto.randomUUID(), title: required(args.title, "Event title").slice(0, 300), start: start.toISOString(), end: end.toISOString(), location: String(args.location || "").slice(0, 500), note: String(args.note || "").slice(0, 3000), createdAt: new Date().toISOString() };
      this.data.calendar.push(event);
      this.data.calendar.sort((a, b) => a.start.localeCompare(b.start));
      this.save();
      return JSON.stringify(event, null, 2);
    }
    if (operation === "list" || operation === "briefing") {
      const from = new Date(args.from || new Date().setHours(0, 0, 0, 0)).getTime();
      const to = new Date(args.to || from + 7 * 86400000).getTime();
      const events = this.data.calendar.filter((event) => new Date(event.start).getTime() >= from && new Date(event.start).getTime() <= to);
      return JSON.stringify(operation === "briefing" ? { range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, events, count: events.length } : events, null, 2);
    }
    if (operation === "delete") {
      requireConfirm(args, "Deleting a calendar event");
      const index = this.data.calendar.findIndex((event) => event.id === args.id);
      if (index < 0) return "No calendar event matched that ID.";
      this.data.calendar.splice(index, 1); this.save(); return "Calendar event deleted.";
    }
    throw new Error("Unknown calendar operation.");
  }

  async documents(args, roots) {
    const operation = args.operation || "wordCount";
    if (operation === "wordCount" || operation === "cleanText" || operation === "emailTemplate") {
      const text = textSource(args, this.allowedPath, roots);
      if (operation === "wordCount") return JSON.stringify({ words: (text.match(/\b[\p{L}\p{N}'-]+\b/gu) || []).length, characters: text.length, charactersWithoutSpaces: text.replace(/\s/g, "").length, lines: text.split(/\r?\n/).length });
      if (operation === "cleanText") return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      const subject = String(args.subject || "Regarding your message");
      return `Subject: ${subject}\n\nHello ${args.recipient || "there"},\n\n${text.trim()}\n\nBest regards,\n${args.sender || "Jay"}`;
    }
    const output = this.allowedPath(required(args.output, "Output path"), roots);
    if (fs.existsSync(output)) requireConfirm(args, `Overwriting ${output}`);
    if (operation === "textToPdf") {
      const document = await PDFDocument.create();
      const font = await document.embedFont(StandardFonts.Helvetica);
      const lines = wrapText(textSource(args, this.allowedPath, roots));
      let page = document.addPage([612, 792]); let y = 750;
      for (const line of lines) {
        if (y < 45) { page = document.addPage([612, 792]); y = 750; }
        page.drawText(line, { x: 45, y, size: 11, font, color: rgb(0.08, 0.1, 0.12) }); y -= 16;
      }
      fs.writeFileSync(output, await document.save()); return `Created ${output}.`;
    }
    if (operation === "mergePdf") {
      const document = await PDFDocument.create();
      for (const input of args.inputs || []) {
        const source = await PDFDocument.load(fs.readFileSync(this.allowedPath(input, roots)));
        const pages = await document.copyPages(source, source.getPageIndices()); pages.forEach((page) => document.addPage(page));
      }
      if (!document.getPageCount()) throw new Error("At least one input PDF is required.");
      fs.writeFileSync(output, await document.save()); return `Merged ${document.getPageCount()} pages into ${output}.`;
    }
    if (operation === "imagesToPdf") {
      const document = await PDFDocument.create();
      for (const input of args.inputs || []) {
        const imagePath = this.allowedPath(input, roots); const bytes = fs.readFileSync(imagePath); const extension = path.extname(imagePath).toLowerCase();
        const image = extension === ".png" ? await document.embedPng(bytes) : await document.embedJpg(bytes);
        const scale = Math.min(1, 540 / image.width, 720 / image.height); const width = image.width * scale; const height = image.height * scale;
        const page = document.addPage([612, 792]); page.drawImage(image, { x: (612 - width) / 2, y: (792 - height) / 2, width, height });
      }
      if (!document.getPageCount()) throw new Error("At least one PNG or JPEG input is required.");
      fs.writeFileSync(output, await document.save()); return `Created ${output} from ${document.getPageCount()} images.`;
    }
    if (operation === "officeToPdf") {
      const input = this.allowedPath(required(args.path, "Office or HTML input path"), roots); const extension = path.extname(input).toLowerCase();
      let script;
      if ([".doc", ".docx", ".rtf", ".txt", ".html", ".htm"].includes(extension)) script = `$a=New-Object -ComObject Word.Application; $a.Visible=$false; try{$d=$a.Documents.Open(${psQuote(input)},$false,$true);$d.ExportAsFixedFormat(${psQuote(output)},17);$d.Close($false)}finally{$a.Quit()}`;
      else if ([".xls", ".xlsx", ".xlsm", ".csv"].includes(extension)) script = `$a=New-Object -ComObject Excel.Application; $a.Visible=$false; $a.DisplayAlerts=$false; try{$d=$a.Workbooks.Open(${psQuote(input)});$d.ExportAsFixedFormat(0,${psQuote(output)});$d.Close($false)}finally{$a.Quit()}`;
      else if ([".ppt", ".pptx", ".pptm"].includes(extension)) script = `$a=New-Object -ComObject PowerPoint.Application; try{$d=$a.Presentations.Open(${psQuote(input)},$true,$false,$false);$d.SaveAs(${psQuote(output)},32);$d.Close()}finally{$a.Quit()}`;
      else throw new Error("Supported inputs are Word, Excel, PowerPoint, text, CSV, RTF, and HTML files.");
      await powershell(script); return `Converted ${input} to ${output}.`;
    }
    if (operation === "pdfToText") {
      const input = this.allowedPath(required(args.path, "Input PDF path"), roots);
      await powershell(`$a=New-Object -ComObject Word.Application; $a.Visible=$false; $a.DisplayAlerts=0; try{$d=$a.Documents.Open(${psQuote(input)},$false,$true,$false);$d.SaveAs2(${psQuote(output)},2);$d.Close($false)}finally{$a.Quit()}`);
      return `Extracted PDF text to ${output}.`;
    }
    const input = this.allowedPath(required(args.path, "Input PDF path"), roots);
    const source = await PDFDocument.load(fs.readFileSync(input));
    if (operation === "splitPdf") {
      const requestedPages = (args.pages || []).map(Number).filter((page) => page >= 1 && page <= source.getPageCount());
      if (!requestedPages.length) throw new Error("Provide one or more valid one-based page numbers.");
      const document = await PDFDocument.create(); const copied = await document.copyPages(source, requestedPages.map((page) => page - 1)); copied.forEach((page) => document.addPage(page));
      fs.writeFileSync(output, await document.save()); return `Created ${output} with ${copied.length} pages.`;
    }
    if (operation === "rotatePdf") source.getPages().forEach((page) => page.setRotation(degrees(Number(args.angle) || 90)));
    else if (operation === "compressPdf") {
      fs.writeFileSync(output, await source.save({ useObjectStreams: true, addDefaultPage: false })); return `Repacked PDF to ${output}.`;
    }
    else if (operation === "watermarkPdf") {
      const font = await source.embedFont(StandardFonts.HelveticaBold); const label = String(args.watermark || "JARVIS").slice(0, 100);
      source.getPages().forEach((page) => page.drawText(label, { x: page.getWidth() / 4, y: page.getHeight() / 2, size: 36, font, color: rgb(0.5, 0.5, 0.5), opacity: 0.22, rotate: degrees(35) }));
    } else throw new Error("Unknown PDF operation.");
    fs.writeFileSync(output, await source.save()); return `Created ${output}.`;
  }

  async creative(args, roots) {
    const operation = args.operation || "palette";
    if (operation === "qrCode") {
      const output = this.allowedPath(required(args.output, "PNG output path"), roots);
      if (fs.existsSync(output)) requireConfirm(args, `Overwriting ${output}`);
      await QRCode.toFile(output, required(args.text, "QR content"), { errorCorrectionLevel: "H", margin: 2, width: Math.min(Math.max(Number(args.size) || 512, 128), 2048) });
      return `Created QR code at ${output}.`;
    }
    if (operation === "palette") {
      const hue = Number.isFinite(Number(args.hue)) ? Number(args.hue) % 360 : crypto.randomInt(0, 360);
      const hslToHex = (h, s, l) => {
        s /= 100; l /= 100; const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs((h / 60) % 2 - 1)); const m = l - c / 2;
        let values = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
        return `#${values.map((value) => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("")}`;
      };
      return JSON.stringify([0, 35, 150, 210, 325].map((offset, index) => ({ name: ["primary", "support", "contrast", "cool neutral", "accent"][index], hex: hslToHex((hue + offset) % 360, index === 3 ? 18 : 62, index === 3 ? 36 : 52) })), null, 2);
    }
    if (operation === "screenColor") {
      return powershell("Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $p=[System.Windows.Forms.Cursor]::Position; $b=New-Object System.Drawing.Bitmap 1,1; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($p,0,0,$b.Size); $c=$b.GetPixel(0,0); $g.Dispose(); $b.Dispose(); @{x=$p.X;y=$p.Y;red=$c.R;green=$c.G;blue=$c.B;hex=('#{0:X2}{1:X2}{2:X2}' -f $c.R,$c.G,$c.B)} | ConvertTo-Json -Compress");
    }
    if (operation === "imageConvert") {
      const input = this.allowedPath(required(args.path, "Input image"), roots); const output = this.allowedPath(required(args.output, "Output image"), roots);
      if (fs.existsSync(output)) requireConfirm(args, `Overwriting ${output}`);
      const format = path.extname(output).replace(".", "").toLowerCase();
      if (!/^(?:png|jpe?g|bmp|gif)$/.test(format)) throw new Error("Output format must be PNG, JPG, BMP, or GIF.");
      const imageFormat = /jpe?g/.test(format) ? "Jpeg" : titleCase(format);
      await powershell(`Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile(${psQuote(input)}); $i.Save(${psQuote(output)},[System.Drawing.Imaging.ImageFormat]::${imageFormat}); $i.Dispose()`);
      return `Converted image to ${output}.`;
    }
    throw new Error("Unknown creative operation.");
  }

  async security(args, roots) {
    const operation = args.operation || "scanUrl";
    if (operation === "portScan") {
      const host = required(args.host, "Host"); const ports = [...new Set((args.ports || [22, 80, 443, 3389]).map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))].slice(0, 100);
      const scan = (port) => new Promise((resolve) => { const socket = net.createConnection({ host, port }); const finish = (open) => { socket.destroy(); resolve({ port, open }); }; socket.setTimeout(800); socket.once("connect", () => finish(true)); socket.once("timeout", () => finish(false)); socket.once("error", () => finish(false)); });
      return JSON.stringify({ host, results: (await Promise.all(ports.map(scan))).filter((item) => item.open), scanned: ports.length }, null, 2);
    }
    if (operation === "scanUrl") {
      const url = new URL(required(args.url, "URL"));
      const flags = [];
      if (url.protocol !== "https:") flags.push("not HTTPS");
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)) flags.push("raw IP address");
      if (url.hostname.split(".").length > 5) flags.push("many subdomains");
      if (url.href.length > 180) flags.push("unusually long URL");
      if (/@|xn--|%00/i.test(url.href)) flags.push("obfuscation marker");
      return JSON.stringify({ url: url.href, risk: flags.length >= 2 ? "high caution" : flags.length ? "caution" : "no obvious local warning", flags, note: "This local heuristic is not a malware verdict." }, null, 2);
    }
    const input = this.allowedPath(required(args.path, "Input file"), roots); const output = this.allowedPath(required(args.output, "Output file"), roots);
    const password = required(args.password, "Vault password");
    requireConfirm(args, operation === "encrypt" ? "Encrypting a file" : "Decrypting a file");
    if (operation === "encrypt") {
      const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12); const key = crypto.scryptSync(password, salt, 32); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(fs.readFileSync(input)), cipher.final()]); const tag = cipher.getAuthTag();
      fs.writeFileSync(output, Buffer.concat([Buffer.from("JARVISVAULT1"), salt, iv, tag, encrypted]), { mode: 0o600 }); return `Encrypted ${input} to ${output}.`;
    }
    if (operation === "decrypt") {
      const data = fs.readFileSync(input); if (!["JARVISVAULT1", "JERVISVAULT1"].includes(data.subarray(0, 12).toString())) throw new Error("This is not a JARVIS vault file.");
      const salt = data.subarray(12, 28); const iv = data.subarray(28, 40); const tag = data.subarray(40, 56); const key = crypto.scryptSync(password, salt, 32); const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(tag);
      fs.writeFileSync(output, Buffer.concat([decipher.update(data.subarray(56)), decipher.final()]), { mode: 0o600 }); return `Decrypted to ${output}.`;
    }
    throw new Error("Unknown security operation.");
  }

  async diagnostics(args) {
    const operation = args.operation || "system";
    const scripts = {
      system: "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime,@{n='FreeMemoryMB';e={[math]::Round($_.FreePhysicalMemory/1024)}} | ConvertTo-Json -Compress",
      battery: "Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object Name,EstimatedChargeRemaining,BatteryStatus,Status | ConvertTo-Json -Compress",
      disk: "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}} | ConvertTo-Json -Compress",
      network: "Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,InterfaceDescription,LinkSpeed,MacAddress | ConvertTo-Json -Compress",
      usb: "Get-PnpDevice -PresentOnly | Where-Object InstanceId -like 'USB*' | Select-Object Class,FriendlyName,Status | ConvertTo-Json -Compress",
      startup: "Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Json -Compress",
      apps: "Get-StartApps | Sort-Object Name | Select-Object -First 300 Name,AppID | ConvertTo-Json -Compress",
      processes: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 ProcessName,Id,CPU,@{n='MemoryMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress",
    };
    if (scripts[operation]) return (await powershell(scripts[operation])) || "No matching information was reported.";
    if (operation === "pythonPackages") return run("python.exe", ["-m", "pip", "list", "--format=json"]).catch(() => "Python is not available on PATH.");
    throw new Error("Unknown diagnostic operation.");
  }

  async fileManagement(args, roots) {
    const operation = args.operation || "organizePreview";
    if (operation === "backup") {
      requireConfirm(args, "Creating a private JARVIS backup"); const output = this.allowedPath(required(args.output, "Backup ZIP output"), roots); if (fs.existsSync(output)) requireConfirm(args, `Overwriting ${output}`);
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-backup-"));
      try {
        const names = ["personal-data.json", "extended-data.json", "meals.json", "memory.jsonl", "diary.jsonl", "knowledge-graph.json", "semantic-memory.json", "dictation-history.jsonl"];
        for (const name of names) { const source = path.join(this.dataDir, name); if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staging, name)); }
        const configPath = path.join(this.dataDir, "config.json");
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, "utf8")); if (config.llm) config.llm.apiKey = ""; if (config.tools) config.tools.braveApiKey = "";
          for (const server of Object.values(config.mcpServers || {})) if (server?.env) server.env = Object.fromEntries(Object.keys(server.env).map((key) => [key, "[redacted]"]));
          fs.writeFileSync(path.join(staging, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
        }
        await powershell(`Compress-Archive -Path ${psQuote(path.join(staging, "*"))} -DestinationPath ${psQuote(output)} -Force`);
        return `Created redacted private backup at ${output}. API keys were excluded.`;
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
    if (operation === "emptyRecycleBin") {
      requireConfirm(args, "Emptying the Recycle Bin"); await powershell("Clear-RecycleBin -Force -ErrorAction Stop"); return "Recycle Bin emptied.";
    }
    const directory = this.allowedPath(required(args.path, "Folder path"), roots);
    const files = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile());
    if (operation === "organizePreview" || operation === "organize") {
      const groups = { Images: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"], Documents: [".pdf", ".doc", ".docx", ".txt", ".rtf", ".xlsx", ".pptx"], Audio: [".mp3", ".wav", ".flac", ".m4a"], Video: [".mp4", ".mkv", ".avi", ".mov", ".webm"], Archives: [".zip", ".rar", ".7z", ".tar", ".gz"], Code: [".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".cs", ".cpp", ".html", ".css"] };
      const moves = files.map((entry) => {
        const extension = path.extname(entry.name).toLowerCase(); const group = Object.entries(groups).find(([, values]) => values.includes(extension))?.[0] || "Other";
        return { from: path.join(directory, entry.name), to: path.join(directory, group, entry.name), group };
      });
      if (operation === "organizePreview") return JSON.stringify(moves.slice(0, 300), null, 2);
      requireConfirm(args, "Organizing files");
      for (const move of moves) { fs.mkdirSync(path.dirname(move.to), { recursive: true }); if (!fs.existsSync(move.to)) fs.renameSync(move.from, move.to); }
      return `Organized ${moves.length} files in ${directory}.`;
    }
    if (operation === "batchRenamePreview" || operation === "batchRename") {
      const prefix = String(args.prefix || "file_").replace(/[<>:"/\\|?*]/g, "_"); const changes = files.map((entry, index) => ({ from: path.join(directory, entry.name), to: path.join(directory, `${prefix}${String(index + 1).padStart(3, "0")}${path.extname(entry.name)}`) }));
      if (operation === "batchRenamePreview") return JSON.stringify(changes.slice(0, 300), null, 2);
      requireConfirm(args, "Batch renaming files");
      const staged = changes.map((change) => ({ ...change, temporary: `${change.from}.${crypto.randomUUID()}.jarvis-tmp` })); staged.forEach((item) => fs.renameSync(item.from, item.temporary)); staged.forEach((item) => fs.renameSync(item.temporary, item.to));
      return `Renamed ${changes.length} files.`;
    }
    throw new Error("Unknown file-management operation.");
  }

  async developer(args, roots) {
    const operation = args.operation || "gitStatus"; const directory = this.allowedPath(args.path || roots[0], roots);
    if (operation === "gitStatus") return run("git.exe", ["-C", directory, "status", "--short", "--branch"]);
    if (operation === "gitDiff") return run("git.exe", ["-C", directory, "diff", "--", ...(args.files || [])]);
    if (operation === "gitCommit") {
      requireConfirm(args, "Creating a Git commit"); const message = required(args.message, "Commit message").slice(0, 500); const files = args.files?.length ? args.files : ["."];
      await run("git.exe", ["-C", directory, "add", "--", ...files]); return run("git.exe", ["-C", directory, "commit", "-m", message], 60000);
    }
    if (operation === "gitPush") { requireConfirm(args, "Pushing Git changes"); return run("git.exe", ["-C", directory, "push"], 120000); }
    const python = String(args.pythonPath || "python.exe");
    if (operation === "pipList") return run(python, ["-m", "pip", "list", "--format=json"]);
    const packageName = required(args.package, "Package name"); if (!/^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?(?:==[A-Za-z0-9_.+-]+)?$/.test(packageName)) throw new Error("Package name contains unsupported characters.");
    if (operation === "pipInstall") { requireConfirm(args, "Installing a Python package"); return run(python, ["-m", "pip", "install", packageName], 300000); }
    if (operation === "pipUninstall") { requireConfirm(args, "Uninstalling a Python package"); return run(python, ["-m", "pip", "uninstall", "-y", packageName], 300000); }
    throw new Error("Unknown developer operation.");
  }

  async phone(args) {
    const operation = args.operation || "status";
    const adb = String(args.adbPath || process.env.ADB_PATH || "adb.exe");
    const devices = await run(adb, ["devices"], 10000).catch(() => { throw new Error("ADB is unavailable. Install Android platform-tools or configure ADB_PATH."); });
    if (operation === "status") return devices;
    const allowed = {
      details: ["shell", "getprop"], battery: ["shell", "dumpsys", "battery"], packages: ["shell", "pm", "list", "packages", "-3"],
      notifications: ["shell", "dumpsys", "notification", "--noredact"], callState: ["shell", "dumpsys", "telephony.registry"],
    };
    if (!allowed[operation]) throw new Error("Unknown phone operation.");
    if (["notifications", "callState"].includes(operation) && args.confirm !== true) throw new Error(`${titleCase(operation)} contains private phone data and requires confirm=true.`);
    return run(adb, allowed[operation], 30000);
  }
}
