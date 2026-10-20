# ga-agent

Node.js-CLI zum Ausführen von LangGraph-Agents. Der erste Stand enthält
ausschließlich den Dummy-Agent **task-collector** – ohne LLM, API-Key,
externe Dienste oder Persistenz.

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
| `ga-agent run <name>` | Einen Agent ausführen |

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

## Aufbau

```text
src/
  cli.ts                   # Argumente, Ausgabe und Exit-Code
  config.ts                # Konfigurationsdatei, Prüfung und Standardwerte
  agents/
    index.ts               # Statische Liste verfügbarer Agents
    task-collector.ts      # Kompilierter Dummy-LangGraph
tests/
  cli.test.ts
  config.test.ts
  task-collector.test.ts
```

Die Ausführungskette ist:

```text
CLI → Konfiguration → Agent-Auswahl → LangGraph → Ausgabe
```

Der Agent führt tatsächlich den Graphen `START → dummy → END` aus.
Der einzige Knoten setzt eine feste Nachricht im Graph-Zustand.
Echte Aufgabensammlung, Modellaufrufe, Tools, Memory und Streaming sind
noch nicht implementiert.

Technik: TypeScript 7 mit ESM, LangGraph mit LangChain Core, Commander,
Zod, Vitest und Oxlint. Das vollständige `langchain`-Paket und
Modelladapter werden für den Dummy nicht benötigt.

## Prüfungen

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Die Tests verwenden temporäre Verzeichnisse statt der echten
Benutzerkonfiguration. Der Agent-Test blockiert Netzwerkaufrufe über
`fetch`; LangSmith-Tracing ist in den Tests deaktiviert.
