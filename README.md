# ga-agent

Node.js-CLI zum Ausführen von LangGraph-Agents. Enthalten ist bislang
der Dummy-Agent **task-collector** – ohne LLM, API-Key, externe Dienste
oder Persistenz, aber mit Unterstützung für lokale Agent Skills.

## Voraussetzungen

- Node.js 22 (ab 22.12), Node.js 24 oder Node.js ab 26
- npm

## Installation und Entwicklung

```bash
npm ci
npm run dev -- --help
npm run dev -- list
npm run dev -- run task-collector
```

Die Ausführung liefert:

```text
task-collector: Dummy erfolgreich ausgeführt.
```

## Build und CLI

```bash
npm run build
npm start -- list
npm start -- run task-collector
```

Optional kann die gebaute CLI lokal verknüpft werden:

```bash
npm link
ga-agent --help
ga-agent list
ga-agent run task-collector
```

Nach Änderungen am Quellcode ist für die gebaute CLI erneut
`npm run build` nötig. Zum Entfernen der Verknüpfung:
`npm uninstall --global ga-agent`.

### Kommandos

| Kommando | Funktion |
| --- | --- |
| `ga-agent --help` | Hilfe anzeigen |
| `ga-agent list` | Agents und ihren Aktivierungsstatus auflisten |
| `ga-agent run <name> [--skill <name>]` | Einen Agent ausführen und optional einen Skill aktivieren |

Erfolgreiche Aufrufe liefern Exit-Code `0`, Fehler Exit-Code `1`.
Unbekannte oder deaktivierte Agents werden nicht ausgeführt.

## Konfiguration

Die optionale JSON-Datei liegt unter:

```text
~/.config/ga-agent/config.json
```

Beispiel mit dem Standardwert:

```json
{
  "agents": {
    "task-collector": {
      "enabled": true
    }
  }
}
```

- Ohne Datei ist `task-collector` aktiviert.
- Ausgelassene Einstellungen werden mit Standardwerten ergänzt; auch `{}` ist gültig.
- Mit `"enabled": false` wird der Agent deaktiviert.
- Ungültiges JSON, falsche Datentypen und unbekannte Einstellungen werden
  mit einer Fehlermeldung abgewiesen.
- Die CLI legt weder die Datei noch das Verzeichnis automatisch an.
- Die Datei enthält bislang keine Provider-, Modell- oder Prompt-Konfiguration.

### Umgebungsvariablen aus `.env`

Zusätzlich wird eine optionale Datei geladen:

```text
~/.config/ga-agent/.env
```

Beispiel:

```dotenv
# Optionale Umgebungsvariablen
LANGSMITH_TRACING=false
```

- Bei `list` und `run` wird die Datei vor dem Import und der Initialisierung
  der Agents in `process.env` geladen, auch ohne `config.json`.
- Bereits gesetzte Umgebungsvariablen haben Vorrang, auch bei leerem Wert.
- Fehlen Datei oder Verzeichnis, läuft die CLI unverändert weiter und legt
  nichts an. Andere Lesefehler werden mit Exit-Code `1` gemeldet.
- Eine `.env` im aktuellen Arbeitsverzeichnis wird nicht geladen.
- `--help` liest weder `.env` noch `config.json`.
- Das Format entspricht dem nativen Node.js-`.env`-Format und unterstützt
  unter anderem Kommentare und Werte in Anführungszeichen.

## Agent Skills

Skills liegen gemeinsam für alle Agents unter `~/.config/ga-agent/skills/`.
Das Format folgt der [Agent-Skills-Spezifikation](https://agentskills.io/specification):
Jeder Skill ist ein unmittelbares Unterverzeichnis mit einer Datei namens
exakt `SKILL.md`.

```text
~/.config/ga-agent/skills/
  task-collection/
    SKILL.md
    references/          # optionale ergänzende Dokumentation
    scripts/             # optionale Skripte; keine automatische Ausführung
    assets/              # optionale Vorlagen und Ressourcen
```

Eine minimale `SKILL.md`:

```markdown
---
name: task-collection
description: Sammelt Aufgaben aus Notizen und strukturiert sie nach Priorität.
---

# Aufgaben sammeln

1. Identifiziere konkrete Aufgaben.
2. Formuliere jede Aufgabe als ausführbaren nächsten Schritt.
```

### Format und Discovery

- `name` und `description` sind verpflichtende YAML-Strings.
- Der Name entspricht dem Verzeichnisnamen und enthält 1–64 Zeichen:
  kleingeschriebene Unicode-Buchstaben/Ziffern und einzelne Bindestriche,
  keine Bindestriche am Anfang oder Ende.
- Die Beschreibung enthält 1–1024 Zeichen und darf nicht nur aus Leerraum bestehen.
- Optional unterstützt werden `license`, `compatibility` (1–500 Zeichen),
  `metadata` (String-zu-String-Mapping) und `allowed-tools` (String).
  Unbekannte Top-Level-Felder werden abgewiesen.
- Bei jedem `run` werden die unmittelbaren Skill-Verzeichnisse in
  deterministischer Reihenfolge geprüft. Es gibt keine rekursive Suche,
  zusätzliche Suchpfade oder agent-spezifischen Freigaben.
- Discovery liest `SKILL.md` zur Formatprüfung, behält aber nur die Metadaten.
  Vollständige Anweisungen werden erst bei Aktivierung erneut geladen und geprüft;
  ergänzende Dateien nur bei expliziter Anforderung gelesen.
- Ohne Skills-Verzeichnis läuft die CLI unverändert weiter und legt nichts an.
  Andere Lesefehler am Hauptverzeichnis führen zu Exit-Code `1`.
- Ungültige einzelne Skills werden mit einer Warnung einschließlich Dateipfad
  übersprungen. Gültige Skills bleiben verfügbar. Wird ein unbekannter oder
  ungültiger Skill explizit angefordert, scheitert der Aufruf mit Exit-Code `1`.
- `list` und `--help` lesen keine Skills. Unbekannte oder deaktivierte Agents
  werden bereits vor der Skill-Discovery abgewiesen.

### Beispiel installieren und mit dem Dummy laden

Das Repository enthält einen Beispiel-Skill einschließlich Referenzdatei:

```bash
mkdir -p ~/.config/ga-agent/skills
cp -R examples/skills/task-collection ~/.config/ga-agent/skills/
npm run dev -- run task-collector --skill task-collection
```

Ausgabe:

```text
task-collector: Dummy erfolgreich ausgeführt. Skill "task-collection" geladen.
```

Ohne `--skill` bleibt die bisherige Ausgabe unverändert. Der gemeinsame Runner
lädt einen explizit gewählten Skill und übergibt ihn dem Dummy. Der Dummy
bestätigt das Laden, interpretiert oder befolgt die Anweisungen aber nicht
fachlich – dafür wäre ein LLM erforderlich. Skills werden nicht ausgeführt
wie JavaScript-Plugins.

### Anbindung zukünftiger Agents

Neue Agents verwenden `AgentContext` aus `src/agents/runtime.ts` als
LangGraph-Kontext-Schema und werden in `src/agents/index.ts` registriert.
Die Registry prüft den gemeinsamen Vertrag über `AgentDefinition`.
`runAgent` stellt pro Ausführung über `runtime.context` bereit:

- `skills`: gemeinsamer Zugriff über `list()`, `load(name)` und
  `readFile(name, relativePath)`.
- `activeSkill`: die vollständigen Daten des explizit aktivierten Skills,
  andernfalls `undefined`.

LLM-Agents verwenden `createSkillSupport(skills, activeSkill)` aus
`src/skills/tools.ts`. Der Helper liefert:

- `prompt`: Skill-Katalog aus Namen und Beschreibungen; bei expliziter
  Aktivierung zusätzlich die geladenen Anweisungen. Ohne Skills ein leerer String.
- `tools`: `load_skill` für vollständige Anweisungen samt Basisverzeichnis
  und `read_skill_file` für ergänzende Textdateien. Ohne Skills eine leere Liste.

Ein LLM-Graph muss diesen Prompt ergänzen sowie die Tools sowohl an sein
Modell binden als auch deren Ausführung im Graphen anbinden. Das ist bewusst
kein Bestandteil des modelllosen Dummys. Der Zugriff erfolgt über den
Laufzeitkontext, nicht über den fachlichen Graph-Zustand.

### Sicherheitsgrenzen

- Absolute Dateipfade, Pfadausbrüche über `..` und Symlinks außerhalb des
  jeweiligen Skill-Verzeichnisses werden beim Lesen abgewiesen. Skill-Verzeichnisse
  dürfen ihrerseits nicht per Symlink aus dem Skills-Hauptverzeichnis herausführen.
- Ressourcen werden als UTF-8-Text gelesen; es gibt keine Skriptausführung.
- `allowed-tools` ist experimentelle Metainformation und erteilt keine
  zusätzlichen Berechtigungen. Auch `compatibility` installiert keine Abhängigkeiten.
- Skill-Inhalte sind keine vertrauenswürdigen Systemanweisungen. Nur vertrauenswürdige
  Skills installieren; die Pfadprüfungen sind keine allgemeine Sandbox und bieten
  keine atomare Isolation gegen gleichzeitig bösartig veränderte Dateisystempfade.

## Aufbau

```text
src/
  cli.ts                   # Argumente, Ausgabe und Exit-Code
  config.ts                # .env, Konfigurationsdatei, Prüfung und Standardwerte
  agents/
    index.ts               # Statische Liste verfügbarer Agents
    runtime.ts             # Gemeinsamer Runner und LangGraph-Kontext
    task-collector.ts      # Kompilierter Dummy-LangGraph
  skills/
    index.ts               # Discovery, Formatprüfung und Dateizugriff
    tools.ts               # Prompt-Katalog und LangChain-Tools
examples/
  skills/task-collection/  # Beispiel-Skill mit Referenzdatei
tests/
  cli.test.ts
  config.test.ts
  task-collector.test.ts
  skills.test.ts
  agent-skills.test.ts
```

Die Ausführungskette ist:

```text
CLI → .env → Konfiguration/Agent-Prüfung → Skill-Discovery → LangGraph → Ausgabe
```

Der Agent führt tatsächlich den Graphen `START → dummy → END` aus.
Der einzige Knoten setzt eine feste Nachricht im Graph-Zustand, optional
mit einer Bestätigung des geladenen Skills. Echte Aufgabensammlung,
Modellaufrufe, Memory und Streaming sind noch nicht implementiert.

Technik: TypeScript 7 mit ESM, LangGraph mit LangChain Core, Commander,
YAML, Zod, Vitest und Oxlint. Das vollständige `langchain`-Paket und
Modelladapter werden für den Dummy nicht benötigt.

## Prüfungen

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Die Tests verwenden temporäre Verzeichnisse statt der echten
Benutzerkonfiguration. Die Agent- und Skill-Integrationstests blockieren
Netzwerkaufrufe über `fetch`; LangSmith-Tracing ist in den Tests deaktiviert.
