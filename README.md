# ga-agent

Node.js-CLI zum Ausführen von LangGraph-Agents. Enthalten ist bislang
der Dummy-Agent **task-collector** mit Unterstützung für lokale Agent Skills
und globale MCP-Server einschließlich interaktivem OAuth. Ohne konfigurierte
MCP-Server werden weder LLM, API-Key noch externe Dienste benötigt.

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
| `ga-agent mcp login <server>` | OAuth-MCP-Server im Browser anmelden |
| `ga-agent mcp logout <server>` | Anmeldung lokal löschen und nach Möglichkeit widerrufen |

Erfolgreiche Aufrufe liefern Exit-Code `0`, Fehler Exit-Code `1`.
Abbruch laufender Agents oder Logins: `130` bei SIGINT, `143` bei SIGTERM.
Unbekannte oder deaktivierte Agents werden nicht ausgeführt.

## Konfiguration

Die optionale JSON-Datei liegt unter:

```text
~/.config/ga-agent/config.json
```

Beispiel mit den Standardwerten:

```json
{
  "agents": {
    "task-collector": {
      "enabled": true
    }
  },
  "mcpServers": {}
}
```

- Ohne Datei ist `task-collector` aktiviert.
- Ausgelassene Einstellungen werden mit Standardwerten ergänzt; auch `{}` ist gültig.
- Mit `"enabled": false` wird der Agent deaktiviert.
- Ungültiges JSON, falsche Datentypen und unbekannte Einstellungen werden
  mit einer Fehlermeldung abgewiesen.
- Die CLI legt keine Konfigurationsdatei automatisch an. Ein expliziter OAuth-Login
  erstellt bei Bedarf das separate Auth-Verzeichnis.
- Die Datei enthält keine LLM-Provider-, Modell- oder Prompt-Konfiguration.

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

- Bei `list`, `run` und `mcp login/logout` wird die Datei vor der Initialisierung
  der Agents beziehungsweise MCP-Anbindung in `process.env` geladen, auch ohne `config.json`.
- Bereits gesetzte Umgebungsvariablen haben Vorrang, auch bei leerem Wert.
- Fehlen Datei oder Verzeichnis, läuft die CLI unverändert weiter und legt
  nichts an. Andere Lesefehler werden mit Exit-Code `1` gemeldet.
- Eine `.env` im aktuellen Arbeitsverzeichnis wird nicht geladen.
- `--help` liest weder `.env` noch `config.json`.
- Das Format entspricht dem nativen Node.js-`.env`-Format und unterstützt
  unter anderem Kommentare und Werte in Anführungszeichen.

## MCP-Server

MCP-Server werden unter `mcpServers` in `config.json` **gemeinsam für alle Agents**
konfiguriert. Unterstützt werden lokale stdio-Prozesse und Streamable HTTP:

```json
{
  "mcpServers": {
    "local-service": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absoluter/pfad/zum/mcp-server.mjs"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      }
    },
    "remote-service": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_TOKEN}"
      }
    }
  }
}
```

- Ohne `mcpServers` oder mit `{}` gibt es keine MCP-Verbindungen.
- Jeder Eintrag ist standardmäßig aktiviert; `"enabled": false` überspringt ihn.
- Servernamen: 1–32 ASCII-Buchstaben/Ziffern, `_` oder `-`, beginnend mit
  einem Buchstaben oder einer Ziffer. Unbekannte Konfigurationsfelder werden abgewiesen.
- stdio benötigt `command`; `args` ist optional und standardmäßig leer. Es gibt
  keine Shell-Auswertung und keine automatische Installation von Serverpaketen.
  Für Skripte absolute Pfade verwenden. Der SDK-Transport übernimmt eine begrenzte
  Standardumgebung; zusätzliche Variablen werden ausdrücklich über `env` übergeben.
- `${VARIABLE}` wird ausschließlich in `env`- und `headers`-Werten aus `process.env`
  ersetzt, nicht rekursiv oder in Befehlen, Argumenten und URLs. Fehlende Variablen
  aktivierter Server führen beim Verbindungsaufbau zum Fehler. Secrets können aus
  `~/.config/ga-agent/.env` stammen; bereits gesetzte Variablen haben Vorrang.
- HTTP-URLs dürfen keine eingebetteten Zugangsdaten oder Fragmente enthalten.
- Tools erhalten Namen wie `mcp__remote-service_search`. Finale Namen müssen
  eindeutig sein, höchstens 64 Zeichen lang und aus ASCII-Buchstaben/Ziffern,
  `_` und `-` bestehen. Ungültige Namen oder Kollisionen brechen den Lauf ab.

### Laufzeit und Fehlerverhalten

Der gemeinsame Runner verbindet aktivierte Server erst nach Agent-Prüfung und
Skill-Validierung. Er stellt deren ausführbare LangChain-Tools in `AgentContext`
bereit und hält die Verbindungen bis zum Ende des Graphen offen. Pro Server gelten
30 Sekunden für Verbindungsaufbau samt Tool-Discovery und standardmäßig für einen
Tool-Aufruf; HTTP-Anfragen sind ebenfalls zeitlich begrenzt.

- `list` und sämtliche Hilfeaufrufe verbinden keine Server und starten keinen Login.
- Unbekannte/deaktivierte Agents und ungültige explizite Skills starten keine Server.
- Ein nicht erreichbarer aktivierter Server oder fehlende OAuth-Anmeldung bricht
  den Lauf mit Exit-Code `1` ab, statt unbemerkt Tools wegzulassen.
- Verbindungen und stdio-Prozesse werden bei Erfolg, Fehler und SIGINT/SIGTERM
  geschlossen, auch wenn nur ein Teil der Server initialisiert wurde.
- Infrastrukturfehler enthalten keine ungefilterten Serverantworten oder Tokens;
  stdio-Server-stderr wird nicht an die CLI weitergereicht.

Der Dummy verbindet konfigurierte Server und erhält deren Tools, ruft aber ohne
LLM keine Tools selbstständig auf. Seine erfolgreiche Ausgabe bleibt unverändert.
MCP-Resources, MCP-Prompts und interaktive MCP-Elicitation sind nicht implementiert.

### Interaktives OAuth

Für einen OAuth-HTTP-Server wird statt eines statischen Authorization-Headers
`auth` konfiguriert:

```json
{
  "mcpServers": {
    "remote-service": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "auth": {
        "type": "oauth"
      }
    }
  }
}
```

```bash
ga-agent mcp login remote-service
ga-agent run task-collector
ga-agent mcp logout remote-service
```

`login` ermittelt die OAuth-Metadaten, verwendet Authorization Code mit PKCE/S256
und öffnet den Browser. Die Login-URL wird zusätzlich im Terminal angezeigt und
kann bei Bedarf manuell geöffnet werden. Der Callback lauscht ausschließlich auf
`127.0.0.1`; `state`, einmalige Verwendung und die Issuer-Zuordnung werden geprüft.
Der Login endet spätestens nach fünf Minuten. Abbruch und Timeout schließen den
Callback-Listener. CLI und Browser müssen auf demselben Rechner laufen; es gibt
keinen Device-Code- oder gehosteten Callback-Flow für Remote-/SSH-Logins.

OAuth benötigt HTTPS, ausgenommen Loopback-Adressen für lokale Entwicklung.
Der Authorization-Server muss PKCE/S256 in seinen Metadaten bekanntgeben.
Automatische Registrierung wird nur verwendet, wenn der Server sie unterstützt.
Alternativ sind unter `auth` verfügbar:

- `clientId`: vorregistrierte öffentliche Client-ID, ohne eingebautes Client-Secret.
- `clientMetadataUrl`: HTTPS-URL eines extern bereitgestellten Client-ID-Metadatendokuments,
  wenn der Authorization-Server dieses Verfahren unterstützt. Die CLI hostet kein Dokument.
- `scopes`: Array explizit gewünschter OAuth-Scopes.
- `redirectPort`: fester Loopback-Port für vorregistrierte Redirect-URIs, beispielsweise
  `8090` für `http://127.0.0.1:8090/oauth/callback`. Ohne Vorgabe wird beim ersten Login
  ein freier Port gewählt und bei weiterer Anmeldung derselben Konfiguration wiederverwendet.

OAuth und ein statischer `Authorization`-Header dürfen nicht kombiniert werden.
Die Anmeldung gilt für alle Agents desselben Benutzers. `run` verwendet gespeicherte
Tokens und erneuert sie bei Ablauf oder einer 401-Antwort, soweit Refresh möglich ist.
Es öffnet **niemals selbstständig einen Browser**. Ist eine neue Anmeldung nötig,
weist die Fehlermeldung auf `ga-agent mcp login <server>` hin. Das gilt ebenso in CI.

### OAuth-Daten und Sicherheitsgrenzen

- Tokens und Registrierungsdaten liegen separat unter `~/.config/ga-agent/auth/`:
  Verzeichnis `0700`, Dateien `0600`, jeweils im Besitz des aktuellen Benutzers.
  Unsichere Berechtigungen und Symlinks an Auth-Verzeichnis/-Dateien werden abgewiesen.
- **Die Dateien sind nicht verschlüsselt.** Es gibt derzeit keine Schlüsselbund-Anbindung.
  Die Ablage vor fremdem Zugriff schützen und nicht in Git einchecken oder weitergeben.
- Dateinamen werden aus dem Servernamen abgeleitet; Inhalte sind an Server-URL,
  OAuth-Konfiguration und Authorization-Issuer gebunden. Nach Konfigurationsänderungen
  kann ein neuer Login erforderlich sein. Tokens werden nicht in den Agent-Kontext,
  Prompts oder CLI-Fehlermeldungen aufgenommen.
- Token-Sätze werden atomar gespeichert. Prozessübergreifende Sperren mit Heartbeat
  koordinieren parallele Refreshes und Refresh-Token-Rotation. Nach hartem Prozessabbruch
  kann eine verwaiste Sperre bis zu einer Minute bestehen bleiben; dann erneut versuchen.
- `logout` versucht einen Widerruf, wenn ein entsprechender Endpoint bekannt ist,
  und löscht die lokalen Credentials auch bei einem Widerrufsfehler. In diesem Fall
  wird ein Fehler gemeldet. Ohne Revocation-Endpoint ist Logout ausschließlich lokal.
- Alle Agents erhalten die Berechtigungen aller aktivierten Server. Es gibt keine
  agent-spezifischen Freigaben und keine Sandbox: lokale Prozesse laufen mit den
  Rechten des CLI-Benutzers, Remote-Tools mit den Rechten der hinterlegten Anmeldung.
  Nur vertrauenswürdige Server konfigurieren; Tool-Inhalte sind nicht automatisch
  vertrauenswürdige Systemanweisungen.

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
- `mcpTools`: ausführbare Tools aller aktivierten MCP-Server, ohne Zugangsdaten.

Die CLI übergibt die geladenen `mcpServers` an `runAgent`. Bei direkter Verwendung
von `runAgent` werden diese ebenfalls ausdrücklich als Option übergeben.

LLM-Agents verwenden `createAgentSupport(context)` aus `src/agents/tools.ts`.
Der Helper kombiniert die bestehende Skill-Unterstützung mit MCP und liefert:

- `prompt`: Skill-Katalog aus Namen und Beschreibungen; bei expliziter
  Aktivierung zusätzlich die geladenen Anweisungen. Ohne Skills ein leerer String.
- `tools`: `load_skill` für vollständige Anweisungen samt Basisverzeichnis
  und `read_skill_file` für ergänzende Textdateien sowie alle `mcpTools`.
  Ohne installierte Skills entfallen nur die Skill-Tools. Ohne Skills und MCP
  ist die Liste leer. Finale Tool-Namen werden auf Kollisionen geprüft.

`createSkillSupport` aus `src/skills/tools.ts` bleibt als reiner Skill-Helper verfügbar.

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
    tools.ts               # Gemeinsame Skill- und MCP-Tool-Liste
    task-collector.ts      # Kompilierter Dummy-LangGraph
  mcp/
    index.ts               # SDK-Verbindungen, LangChain-Tools und Cleanup
    oauth.ts               # Browser-Login, Callback, Refresh und Logout
    credentials.ts         # Geschützte atomare Ablage und Refresh-Sperren
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
  mcp.test.ts
  oauth.test.ts
  mcp-cli.test.ts
  fixtures/                # Lokaler stdio-Testserver
  helpers/                 # Lokaler HTTP-/OAuth-Testserver
```

Die Ausführungskette ist:

```text
CLI → .env → Konfiguration/Agent-Prüfung → Skills → MCP-Tools → LangGraph → MCP-Cleanup → Ausgabe
```

Der Agent führt tatsächlich den Graphen `START → dummy → END` aus.
Der einzige Knoten setzt eine feste Nachricht im Graph-Zustand, optional
mit einer Bestätigung des geladenen Skills. Echte Aufgabensammlung,
Modellaufrufe, Memory und Streaming sind noch nicht implementiert.

Technik: TypeScript 7 mit ESM, LangGraph mit LangChain Core, MCP SDK mit
LangChain-MCP-Tool-Adapter, Commander, YAML, Zod, proper-lockfile, Vitest und Oxlint. Das vollständige `langchain`-Paket und
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
Die MCP-/OAuth-Tests verwenden ausschließlich lokale Testserver und einen
simulierten Browserstart, keine externen Dienste, echten Logins oder API-Keys.
Sie prüfen auch parallele CLI-Refreshes und den Prozess-Cleanup bei SIGTERM.
