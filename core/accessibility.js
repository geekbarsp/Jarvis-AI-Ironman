import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function ps(value) { return `'${String(value || "").replace(/'/g, "''")}'`; }

export class WindowsAccessibilityAdapter {
  async perform(operation, args = {}) {
    if (process.platform !== "win32") throw new Error("Accessibility control currently requires Windows.");
    const script = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $root=[System.Windows.Automation.AutomationElement]::RootElement; $windowCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,${ps(args.windowTitle)}); $window=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$windowCondition); if(-not $window){throw 'Window not found.'}; $operation=${ps(operation)}; $name=${ps(args.name)}; $automationId=${ps(args.automationId)}; $controlType=${ps(args.controlType)}; $max=[math]::Max(1,[math]::Min(200,[int]${Number(args.limit) || 80})); if($operation -eq 'inspect'){ $all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition); $items=@(); for($i=0;$i -lt [math]::Min($all.Count,$max);$i++){ $e=$all.Item($i); $items += [pscustomobject]@{name=$e.Current.Name;automationId=$e.Current.AutomationId;controlType=$e.Current.ControlType.ProgrammaticName;enabled=$e.Current.IsEnabled;offscreen=$e.Current.IsOffscreen;bounds=[pscustomobject]@{x=$e.Current.BoundingRectangle.X;y=$e.Current.BoundingRectangle.Y;width=$e.Current.BoundingRectangle.Width;height=$e.Current.BoundingRectangle.Height}} }; [pscustomobject]@{window=$window.Current.Name;elements=$items} | ConvertTo-Json -Depth 5 -Compress; exit }; $conditions=New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]; if($name){$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name)))}; if($automationId){$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$automationId)))}; if($controlType){$type=[System.Windows.Automation.ControlType]::$controlType; if($type){$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type)))}}; if(-not $conditions.Count){throw 'A name, automationId, or controlType selector is required.'}; $condition=if($conditions.Count -eq 1){$conditions[0]}else{New-Object System.Windows.Automation.AndCondition($conditions.ToArray())}; $element=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition); if(-not $element){throw 'Accessible element not found.'}; if($operation -eq 'find'){[pscustomobject]@{found=$true;name=$element.Current.Name;automationId=$element.Current.AutomationId;controlType=$element.Current.ControlType.ProgrammaticName;enabled=$element.Current.IsEnabled;offscreen=$element.Current.IsOffscreen} | ConvertTo-Json -Compress; exit}; if($operation -eq 'focus'){$element.SetFocus(); [pscustomobject]@{focused=$true;name=$element.Current.Name} | ConvertTo-Json -Compress; exit}; if($operation -eq 'invoke'){ $pattern=$null; if(-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw 'Element does not support InvokePattern.'}; ([System.Windows.Automation.InvokePattern]$pattern).Invoke(); [pscustomobject]@{invoked=$true;name=$element.Current.Name} | ConvertTo-Json -Compress; exit}; if($operation -eq 'setValue'){ $pattern=$null; if(-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){throw 'Element does not support ValuePattern.'}; ([System.Windows.Automation.ValuePattern]$pattern).SetValue(${ps(args.value)}); [pscustomobject]@{changed=$true;name=$element.Current.Name} | ConvertTo-Json -Compress; exit}; throw 'Unsupported accessibility operation.'`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout.trim() || "{}");
  }
}

export class AccessibilityService {
  constructor({ adapter = new WindowsAccessibilityAdapter(), eventBus = null } = {}) {
    this.adapter = adapter;
    this.events = eventBus;
  }

  async execute(args) {
    const operation = String(args.operation || "inspect");
    if (!['inspect', 'find', 'focus', 'invoke', 'setValue'].includes(operation)) throw new Error(`Unknown accessibility operation: ${operation}`);
    if (!String(args.windowTitle || "").trim()) throw new Error("A window title is required for accessibility control.");
    if (["invoke", "setValue"].includes(operation) && args.confirm !== true) throw new Error(`${operation} requires confirm=true after the user requests the UI action.`);
    const result = await this.adapter.perform(operation, args);
    this.events?.publish("ACCESSIBILITY_ACTION", { operation, windowTitle: args.windowTitle, found: result.found, invoked: result.invoked, changed: result.changed });
    return result;
  }
}
