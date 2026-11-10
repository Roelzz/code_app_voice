// Unified DFMEA data model.
//
// One relational schema shared by every DFMEA in the portfolio, aligned to the
// AIAG-VDA 7-step method and linked to ISO 14971 hazard analysis. Every view in
// the app (process steps, structure tree, failure network, risk ratings,
// actions, AI facilitator prompts) is derived from these tables.
//
//   DfmeaProject      1 ─ * StructureElement   (tree via parentId)
//   StructureElement  1 ─ * DesignFunction     (requirement traceability)
//   StructureElement  1 ─ * FailureMode        (focus element; functionId → DesignFunction)
//   FailureMode       1 ─ * FailureCause       (failure chain: effect ← mode ← cause)
//   FailureCause      1 ─ * ImprovementAction  (optimization)
//
// Severity belongs to the failure mode's effect; occurrence and detection
// belong to each cause. `origin` + `reviewed` keep AI-suggested content
// separate until the team has reviewed it.

export type StepId =
  | "planning"
  | "structure"
  | "function"
  | "failure"
  | "risk"
  | "optimization"
  | "documentation";

export type ElementLevel = "System" | "Subsystem" | "Component";
export type ActionPriority = "High" | "Medium" | "Low";
export type ActionStatus = "Open" | "In progress" | "Done";
export type ActionKind = "Prevention" | "Detection";
export type Origin = "team" | "ai";

export interface Participant {
  name: string;
  role: string;
}

export interface DfmeaProject {
  id: string;
  product: string;
  productLine: string;
  revision: string;
  scope: string;
  method: string;
  facilitator: string;
  participants: Participant[];
  currentStep: StepId;
}

export interface StructureElement {
  id: string;
  parentId: string | null;
  name: string;
  level: ElementLevel;
  owner?: string;
}

export interface DesignFunction {
  id: string;
  elementId: string;
  description: string;
  requirementRef: string;
}

export interface FailureMode {
  id: string;
  elementId: string;
  functionId: string | null;
  description: string;
  effect: string;
  severity: number | null;
  hazardRef: string;
  origin: Origin;
  reviewed: boolean;
}

export interface FailureCause {
  id: string;
  failureModeId: string;
  description: string;
  preventionControl: string;
  occurrence: number | null;
  detectionControl: string;
  detection: number | null;
  priority: ActionPriority | null;
  origin: Origin;
  reviewed: boolean;
}

export interface ImprovementAction {
  id: string;
  causeId: string;
  description: string;
  kind: ActionKind;
  owner: string;
  due: string | null;
  status: ActionStatus;
  origin: Origin;
}

export interface DfmeaDataset {
  project: DfmeaProject;
  elements: StructureElement[];
  functions: DesignFunction[];
  failureModes: FailureMode[];
  causes: FailureCause[];
  actions: ImprovementAction[];
}

export const STEPS: { id: StepId; number: number; label: string; title: string; goal: string }[] = [
  {
    id: "planning",
    number: 1,
    label: "Planning",
    title: "Planning & preparation",
    goal: "Agree scope, team, timing and rating scales before the analysis starts.",
  },
  {
    id: "structure",
    number: 2,
    label: "Structure",
    title: "Structure analysis",
    goal: "Break the product into system, subsystems and components so every interface is visible.",
  },
  {
    id: "function",
    number: 3,
    label: "Function",
    title: "Function analysis",
    goal: "Link each element to the functions and requirements it must deliver.",
  },
  {
    id: "failure",
    number: 4,
    label: "Failure",
    title: "Failure analysis",
    goal: "Build failure chains: the effect on patient or system, the failure mode, and its design cause.",
  },
  {
    id: "risk",
    number: 5,
    label: "Risk",
    title: "Risk analysis",
    goal: "Rate severity, occurrence and detection for every chain and agree an action priority.",
  },
  {
    id: "optimization",
    number: 6,
    label: "Optimization",
    title: "Optimization",
    goal: "Assign actions that lower occurrence or improve detection, each with an owner and due date.",
  },
  {
    id: "documentation",
    number: 7,
    label: "Documentation",
    title: "Results documentation",
    goal: "Record decisions, open actions and residual risk for the design history file.",
  },
];

export const RATINGS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const PRIORITIES: ActionPriority[] = ["High", "Medium", "Low"];
export const ACTION_STATUSES: ActionStatus[] = ["Open", "In progress", "Done"];

/** Risk priority number: severity × occurrence × detection (null until all three are rated). */
export function riskPriorityNumber(
  severity: number | null,
  occurrence: number | null,
  detection: number | null,
): number | null {
  if (severity === null || occurrence === null || detection === null) return null;
  return severity * occurrence * detection;
}

export function isChainRated(mode: FailureMode, cause: FailureCause): boolean {
  return mode.severity !== null && cause.occurrence !== null && cause.detection !== null;
}

/** Ids of an element and every element beneath it. */
export function subtreeIds(elements: StructureElement[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const element of elements) {
      if (element.parentId && ids.has(element.parentId) && !ids.has(element.id)) {
        ids.add(element.id);
        added = true;
      }
    }
  }
  return ids;
}

/** Root-to-element path, used for breadcrumbs and AI context. */
export function elementPath(elements: StructureElement[], id: string): StructureElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const path: StructureElement[] = [];
  let current = byId.get(id);
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export const SAMPLE_DFMEA: DfmeaDataset = {
  project: {
    id: "DFMEA-PM-0142",
    product: "Wearable vital-signs patch W2",
    productLine: "Patient monitoring",
    revision: "C",
    scope: "Patch hardware, firmware and adhesive. Bedside hub and central station are out of scope.",
    method: "AIAG-VDA DFMEA, 1–10 rating scales, ISO 14971 hazard links",
    facilitator: "Lotte Verhoeven",
    participants: [
      { name: "Lotte Verhoeven", role: "Quality & reliability (facilitator)" },
      { name: "Pieter van Dam", role: "Electronics" },
      { name: "Ines Duarte", role: "Materials" },
      { name: "Sanjay Rao", role: "Algorithms" },
      { name: "Marta Kowalski", role: "Manufacturing engineering" },
      { name: "Amira Haddad", role: "Clinical affairs" },
      { name: "Tomás Rivera", role: "Regulatory affairs" },
    ],
    currentStep: "risk",
  },
  elements: [
    { id: "E-00", parentId: null, name: "Wearable vital-signs patch W2", level: "System", owner: "Lotte Verhoeven" },
    { id: "E-10", parentId: "E-00", name: "Sensing front-end", level: "Subsystem", owner: "Sanjay Rao" },
    { id: "E-11", parentId: "E-10", name: "ECG electrodes", level: "Component" },
    { id: "E-12", parentId: "E-10", name: "Skin temperature sensor", level: "Component" },
    { id: "E-13", parentId: "E-10", name: "Accelerometer", level: "Component" },
    { id: "E-20", parentId: "E-00", name: "Power", level: "Subsystem", owner: "Pieter van Dam" },
    { id: "E-21", parentId: "E-20", name: "Li-ion coin cell", level: "Component" },
    { id: "E-22", parentId: "E-20", name: "Battery management IC", level: "Component" },
    { id: "E-30", parentId: "E-00", name: "Enclosure & adhesive", level: "Subsystem", owner: "Marta Kowalski" },
    { id: "E-31", parentId: "E-30", name: "Hydrocolloid adhesive", level: "Component" },
    { id: "E-32", parentId: "E-30", name: "Over-molded housing", level: "Component" },
    { id: "E-40", parentId: "E-00", name: "Connectivity & firmware", level: "Subsystem", owner: "Pieter van Dam" },
    { id: "E-41", parentId: "E-40", name: "BLE radio & antenna", level: "Component" },
    { id: "E-42", parentId: "E-40", name: "Alarm firmware", level: "Component" },
  ],
  functions: [
    { id: "F-00", elementId: "E-00", description: "Continuously monitor vital signs of general-ward patients", requirementRef: "SRS-SYS-001" },
    { id: "F-01", elementId: "E-11", description: "Acquire single-lead ECG with motion artefact within spec", requirementRef: "SRS-ECG-004" },
    { id: "F-02", elementId: "E-12", description: "Measure skin temperature within ±0.3 °C", requirementRef: "SRS-TMP-002" },
    { id: "F-03", elementId: "E-13", description: "Derive respiration rate from chest-wall motion", requirementRef: "SRS-RR-007" },
    { id: "F-04", elementId: "E-21", description: "Power continuous monitoring for 5 days", requirementRef: "SRS-PWR-001" },
    { id: "F-05", elementId: "E-22", description: "Stop charging on over-voltage or over-temperature", requirementRef: "SRS-PWR-009" },
    { id: "F-06", elementId: "E-31", description: "Hold the patch on skin for 5 days without injury", requirementRef: "SRS-MEC-003" },
    { id: "F-07", elementId: "E-32", description: "Keep electronics dry during showering (IPX4)", requirementRef: "SRS-MEC-011" },
    { id: "F-08", elementId: "E-41", description: "Deliver vitals to the bedside hub every 60 s", requirementRef: "SRS-COM-002" },
    { id: "F-09", elementId: "E-42", description: "Raise a deterioration alert within 2 minutes", requirementRef: "SRS-FW-015" },
  ],
  failureModes: [
    { id: "FM-01", elementId: "E-11", functionId: "F-01", description: "Electrode loses skin contact during patient movement", effect: "ECG signal lost; arrhythmia episodes not captured", severity: 8, hazardRef: "HAZ-021", origin: "team", reviewed: true },
    { id: "FM-02", elementId: "E-12", functionId: "F-02", description: "Skin temperature reads 1 °C low", effect: "Fever onset detected late", severity: 6, hazardRef: "HAZ-034", origin: "team", reviewed: true },
    { id: "FM-03", elementId: "E-13", functionId: "F-03", description: "Respiration rate over-reported while the patient talks", effect: "False deterioration alerts add to alarm fatigue", severity: 5, hazardRef: "HAZ-040", origin: "team", reviewed: true },
    { id: "FM-04", elementId: "E-21", functionId: "F-04", description: "Cell swells after repeated charge cycles", effect: "Housing cracks; burn risk to skin", severity: 9, hazardRef: "HAZ-007", origin: "team", reviewed: true },
    { id: "FM-05", elementId: "E-22", functionId: "F-05", description: "Over-temperature cut-off does not trigger", effect: "Cell overheats on skin; thermal burn", severity: 10, hazardRef: "HAZ-007", origin: "team", reviewed: true },
    { id: "FM-06", elementId: "E-31", functionId: "F-06", description: "Adhesive irritates skin", effect: "Skin injury; patient removes the patch early", severity: 7, hazardRef: "HAZ-015", origin: "team", reviewed: true },
    { id: "FM-07", elementId: "E-32", functionId: "F-07", description: "Water enters the housing during showering", effect: "Short circuit; monitoring stops without warning", severity: 8, hazardRef: "HAZ-022", origin: "team", reviewed: true },
    { id: "FM-08", elementId: "E-41", functionId: "F-08", description: "Vitals packets dropped before reaching the hub", effect: "Gaps in the central-station trend", severity: 6, hazardRef: "HAZ-030", origin: "team", reviewed: true },
    { id: "FM-09", elementId: "E-42", functionId: "F-09", description: "Deterioration alert delayed beyond 2 minutes", effect: "Delayed clinical response to a deteriorating patient", severity: 9, hazardRef: "HAZ-001", origin: "team", reviewed: true },
  ],
  causes: [
    { id: "C-01", failureModeId: "FM-01", description: "Hydrocolloid saturates with sweat after 48 h", preventionControl: "Adhesive selected per sweat-soak spec MEC-TS-12", occurrence: 5, detectionControl: "72-hour wear study, 30 volunteers", detection: 7, priority: "High", origin: "team", reviewed: true },
    { id: "C-02", failureModeId: "FM-01", description: "Electrode gel dries out before day 5", preventionControl: "Gel formulation shelf-life test", occurrence: 3, detectionControl: "Accelerated ageing test (ASTM F1980)", detection: 3, priority: "Low", origin: "team", reviewed: true },
    { id: "C-03", failureModeId: "FM-02", description: "Thermal pad misaligned during assembly", preventionControl: "Assembly fixture with locating pin", occurrence: 4, detectionControl: "End-of-line thermal calibration", detection: 3, priority: "Low", origin: "team", reviewed: true },
    { id: "C-04", failureModeId: "FM-03", description: "Filter passes speech-induced chest vibration", preventionControl: "Algorithm design review", occurrence: 6, detectionControl: "Clinical validation set including speech", detection: 6, priority: "Medium", origin: "team", reviewed: true },
    { id: "C-05", failureModeId: "FM-04", description: "Charge voltage exceeds cell rating with an out-of-tolerance charger", preventionControl: "Charger specified at ±1 % regulation", occurrence: 3, detectionControl: "500-cycle charge test", detection: 4, priority: "Low", origin: "team", reviewed: true },
    { id: "C-06", failureModeId: "FM-05", description: "Thermistor placed too far from the cell", preventionControl: "Thermal simulation of the PCB layout", occurrence: 4, detectionControl: "Thermal chamber test at 45 °C", detection: 5, priority: "High", origin: "team", reviewed: true },
    { id: "C-07", failureModeId: "FM-06", description: "Residual monomer above biocompatibility limit", preventionControl: "ISO 10993-10 sensitisation testing", occurrence: 2, detectionControl: "Incoming lot inspection", detection: 6, priority: "Medium", origin: "team", reviewed: true },
    { id: "C-08", failureModeId: "FM-07", description: "Knit-line void in the over-mold near the seal", preventionControl: "Mold-flow analysis", occurrence: 5, detectionControl: "IPX4 spray test on sample basis", detection: 7, priority: "High", origin: "team", reviewed: true },
    { id: "C-09", failureModeId: "FM-08", description: "Antenna detuned by body proximity", preventionControl: "Antenna simulation with tissue phantom", occurrence: 6, detectionControl: "Ward RF survey", detection: 5, priority: "Medium", origin: "team", reviewed: true },
    { id: "C-10", failureModeId: "FM-08", description: "Hub drops connections above 12 patches per room", preventionControl: "", occurrence: null, detectionControl: "", detection: null, priority: null, origin: "team", reviewed: true },
    { id: "C-11", failureModeId: "FM-09", description: "Alert queued behind a batch upload", preventionControl: "Firmware architecture review", occurrence: null, detectionControl: "", detection: null, priority: null, origin: "team", reviewed: true },
  ],
  actions: [
    { id: "A-01", causeId: "C-01", description: "Qualify silicone-gel adhesive in a 5-day sweat-soak test", kind: "Prevention", owner: "Ines Duarte", due: "2026-12-04", status: "In progress", origin: "team" },
    { id: "A-02", causeId: "C-06", description: "Move thermistor onto the cell tab and repeat the 45 °C chamber test", kind: "Prevention", owner: "Pieter van Dam", due: "2026-11-20", status: "Open", origin: "team" },
    { id: "A-03", causeId: "C-08", description: "Run mold-flow study for alternative gate locations", kind: "Prevention", owner: "Marta Kowalski", due: "2026-10-30", status: "Done", origin: "team" },
    { id: "A-04", causeId: "C-08", description: "Introduce 100 % pressure-decay leak test at end of line", kind: "Detection", owner: "Marta Kowalski", due: "2026-12-11", status: "Open", origin: "team" },
    { id: "A-05", causeId: "C-04", description: "Add speech-rejection filter and re-run respiration validation", kind: "Prevention", owner: "Sanjay Rao", due: "2027-01-15", status: "Open", origin: "team" },
  ],
};
