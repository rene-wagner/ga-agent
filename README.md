# ga-agent

Node.js-CLI zum Ausführen von LangGraph-Agents. Agents werden als Markdown-Dateien
unter `~/.config/ga-agent/agents/` definiert und verwenden einen gemeinsamen Graphen.
Der Beispiel-Agent **task-collector** ist ein einfacher Verbindungstest ohne Tools.
Die Infrastruktur für lokale Agent Skills und globale MCP-Server einschließlich
interaktivem OAuth bleibt verfügbar. Die Modellanbindung verwendet OpenRouter;
benannte Modellkonfigurationen lassen sich jedem Agenten einzeln zuordnen.
Für `run` sind eine Modellzuordnung und ein API-Key erforderlich. `list`, Hilfe
und MCP-Anmeldung funktionieren weiterhin ohne LLM-Zugangsdaten.

## Voraussetzungen

- Node.js 22 (ab 22.12), Node.js 24 oder Node.js ab 26
- npm

## Installation und Entwicklung

```bash
npm ci
mkdir -p ~/.config/ga-agent/agents
cp examples/agents/task-collector.md ~/.config/ga-agent/agents/
npm run dev -- --help
npm run dev -- list
npm run dev -- run task-collector
```

Vor `run` die unten beschriebene Modellkonfiguration und den OpenRouter-Key
hinterlegen. Die CLI gibt anschließend die finale Textantwort des Modells aus.
Der Agent bittet das Modell vorerst nur um eine kurze Bestätigung der funktionierenden
LLM-Anbindung. Er führt genau einen Modellaufruf aus, ohne Skills oder Tools an das
Modell zu übergeben. Konfigurierte MCP-Server werden für ihn nicht verbunden.

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
`npm run build` nötig. Neue oder geänderte Markdown-Agents werden dagegen beim
nächsten Aufruf ohne Build geladen. Zum Entfernen der Verknüpfung:
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

Die Standardwerte sind `{"models": {}, "mcpServers": {}}`; auch `{}` ist gültig.
Agent-Definitionen und Prompts stehen nicht in dieser Datei.

- Ausgelassene Einstellungen werden mit Standardwerten ergänzt.
- Ungültiges JSON, falsche Datentypen und unbekannte Einstellungen werden
  mit einer Fehlermeldung abgewiesen.
- Die CLI legt keine Konfigurationsdatei oder Agent-Dateien automatisch an.
  Ein expliziter OAuth-Login erstellt bei Bedarf das separate Auth-Verzeichnis.
- Ohne Modellprofile bleiben `list` und MCP-Anmeldung möglich; `run` meldet
  ein fehlendes Profil. Einen Dummy-Fallback gibt es nicht.

### Modelle und Zuordnung pro Agent

```json
{
  "models": {
    "fast": {
      "provider": "openrouter",
      "model": "openai/gpt-4.1-mini",
      "maxOutputTokens": 2048
    },
    "thorough": {
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4.5",
      "maxOutputTokens": 4096
    }
  },
  "mcpServers": {}
}
```

Eine kopierbare Vorlage liegt unter [`examples/config.json`](examples/config.json),
eine Key-Vorlage unter [`examples/.env.example`](examples/.env.example).
Die Modell-IDs sind Beispiele; Verfügbarkeit, Tool-Unterstützung und Preise vor
Verwendung im [OpenRouter-Modellkatalog](https://openrouter.ai/models) prüfen.

- `fast` und `thorough` sind frei gewählte lokale Konfigurationsnamen:
  1–64 ASCII-Buchstaben/Ziffern, `_` oder `-`, beginnend mit Buchstabe/Ziffer.
- `models.<name>.provider`: derzeit ausschließlich `openrouter`.
- `models.<name>.model`: nicht leere Modell-ID bei OpenRouter, keine lokale Modellliste.
- `maxOutputTokens`: positive Ganzzahl, standardmäßig `2048`, pro Modellanfrage.
- `temperature`: optional, Zahl zwischen `0` und `2`; ohne Angabe gilt das
  Verhalten des gewählten Modells. Nicht jedes Modell unterstützt diese Option.
- Das Feld `model` im Markdown-Frontmatter verweist auf eine benannte Konfiguration.
  Mehrere Agents können dieselbe Konfiguration teilen oder unterschiedliche wählen.
  Es gibt kein globales Standardmodell und keinen automatischen Modellwechsel.
- Ein Wechsel von `model: fast` auf `model: thorough` wirkt beim nächsten Aufruf
  ohne Build. Nur das ausgewählte Profil wird initialisiert und benötigt Zugangsdaten.
- API-Keys und frei konfigurierbare API-Endpunkte sind in JSON nicht erlaubt.
  Alle OpenRouter-Konfigurationen verwenden `OPENROUTER_API_KEY` aus der Umgebung.

### Agents als Markdown

Jeder Agent ist eine unmittelbare `.md`-Datei unter `~/.config/ga-agent/agents/`:

```text
~/.config/ga-agent/
  config.json
  .env
  agents/
    task-collector.md
    another-agent.md
```

Beispiel für `task-collector.md`, auch unter
[`examples/agents/task-collector.md`](examples/agents/task-collector.md):

```markdown
---
description: Prüft die LLM-Anbindung.
model: fast
enabled: true
mcp: false
---

Du bist der task-collector. Antworte kurz und auf Deutsch.

Bestätige bitte kurz, dass die LLM-Anbindung funktioniert.
```

- Der Dateiname ohne `.md` bestimmt den Agent-Namen: 1–64 ASCII-Buchstaben/Ziffern,
  `_` oder `-`, beginnend mit Buchstabe/Ziffer; Groß-/Kleinschreibung wird beachtet.
  Ein zusätzliches `name`-Feld ist nicht erlaubt.
- `model` ist ein Pflichtfeld mit dem Namen eines Modellprofils. Dessen Existenz
  wird erst bei `run` geprüft, nicht bei `list`.
- `description` ist ein optionaler, nicht leerer String.
- `enabled` ist optional und standardmäßig `true`; `false` verhindert die Ausführung.
- `mcp` ist optional und standardmäßig `true`, entsprechend dem bisherigen Runner.
  `false` überspringt alle MCP-Verbindungen. Für den aktuellen Graphen ist `false`
  empfohlen: Er bindet keine Tools, auch nicht bei `mcp: true`.
- Der nicht leere Markdown-Inhalt wird als Systemanweisung gesendet, gefolgt vom
  neutralen Startimpuls „Führe die beschriebenen Anweisungen aus.“. Die konkrete
  Aufgabe gehört deshalb vollständig ins Markdown. Es gibt keine Template- oder
  JavaScript-Auswertung und keine automatische Skill-Einbindung.
- `list` und `run` laden die unmittelbaren `.md`-Dateien jedes Mal neu und sortiert.
  Unterverzeichnisse und andere Dateitypen werden nicht durchsucht. Neue Agents
  benötigen weder eine Registrierung im Code noch einen Build.
- Ein fehlendes oder leeres Agents-Verzeichnis ergibt eine leere Liste. Es gibt
  keinen eingebauten Standard-Agenten und keine automatische Dateierstellung.
- Ungültiges Frontmatter, unbekannte Felder, falsche Datentypen, leere Prompts und
  Lesefehler brechen `list` beziehungsweise `run` mit Dateipfad und Exit-Code `1` ab.
  Datei-Symlinks dürfen nicht aus dem Agents-Verzeichnis herausführen.
- Hilfe und `mcp login/logout` lesen keine Agent-Dateien. `list` initialisiert weder
  Modelle noch MCP-Verbindungen und benötigt keinen API-Key.
- Agent-Dateien sind vertrauenswürdige Systemanweisungen und werden an den
  Modellanbieter übertragen. Nur vertrauenswürdige Definitionen installieren.

### Migration bisheriger Agent-Einstellungen

Der frühere Abschnitt `agents` in `config.json` wird mit einem Migrationshinweis
abgewiesen; es gibt keinen Kompatibilitätslayer und keine JSON-Overrides.

1. Für jeden bisherigen Agenten eine Markdown-Datei unter `agents/` anlegen.
   Für den bisherigen Verbindungstest die Beispiel-Datei kopieren.
2. Die bisherige Modellreferenz und Aktivierung als `model` und `enabled`
   ins Frontmatter übernehmen; der Beispiel-Agent behält `mcp: false`.
3. Den Abschnitt `agents` aus `config.json` entfernen. `models`, `mcpServers`
   und die Zugangsdaten in `.env` bleiben unverändert.

### LLM-Laufzeit und Sicherheitsgrenzen

- Modellanfragen einschließlich eventueller Retries sind auf 60 Sekunden begrenzt.
  Vorübergehende Anfragefehler werden höchstens einmal wiederholt, nicht jedoch
  der komplette Graph oder bereits ausgeführte Tools.
- MCP-Initialisierung und Graph-Ausführung haben zusammen maximal fünf Minuten.
  Der `task-collector` führt genau einen Modellaufruf aus, ohne Tool-Schleife.
  Der Runner begrenzt Graphen zusätzlich auf 32 Schritte. Ein Limit führt zu
  Exit-Code `1` statt einer unvollständigen Erfolgsausgabe. Die Token-Grenze ist
  keine Geldbetragsgrenze. Ungültige/leere Modellantworten brechen den Lauf ab.
- SIGINT/SIGTERM bricht Modellanfragen ab und schließt MCP-Verbindungen.
  Modellfehler werden ohne ungefilterte Providerantworten oder Keys ausgegeben.
- Anfragen werden an OpenRouter und den ausgewählten Modellanbieter übertragen
  und können Kosten verursachen. Der vereinfachte `task-collector` sendet dabei
  ausschließlich seine Markdown-Anweisungen und den neutralen Startimpuls,
  keine Skill-Inhalte oder MCP-Ergebnisse.
- Die MCP-Infrastruktur bietet für andere Agents keine allgemeine Sandbox:
  Nur vertrauenswürdige Server mit geeigneten Berechtigungen bereitstellen.
- LangSmith-Tracing kann bei Aktivierung ebenfalls Prompts und Ergebnisse übertragen.
  Für vertrauliche Daten deaktiviert lassen. Memory und Streaming gibt es noch nicht.

### Umgebungsvariablen aus `.env`

Zusätzlich wird eine optionale Datei geladen:

```text
~/.config/ga-agent/.env
```

Beispiel:

```dotenv
OPENROUTER_API_KEY=dein-openrouter-key
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
- API-Keys liegen dort im Klartext. Die Datei nicht einchecken oder weitergeben
  und mit geeigneten Dateirechten schützen, beispielsweise `chmod 600 ~/.config/ga-agent/.env`.

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

Agents können im Markdown-Frontmatter mit `mcp: false` auf MCP verzichten.
Der `task-collector` verwendet diese Einstellung und überspringt alle Server,
auch bei fehlender OAuth-Anmeldung oder nicht erreichbaren Endpunkten.
Für andere Agents verbindet der gemeinsame Runner aktivierte Server erst nach
Agent-Prüfung und Skill-Validierung sowie Prüfung von Modellkonfiguration und Key.
Er stellt deren ausführbare LangChain-Tools in `AgentContext`
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

Ein zukünftiger Tool-Agent muss die entdeckten Tools an sein Modell binden und
deren Ausführung im Graphen anbinden. Der aktuelle `task-collector` tut das bewusst
nicht und benötigt kein Tool-Calling. OpenRouter wird auf die Unterstützung der
angefragten Parameter eingeschränkt. MCP-Resources, MCP-Prompts und interaktive
MCP-Elicitation sind nicht implementiert.

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

### Beispiel installieren und laden

Das Repository enthält einen Beispiel-Skill einschließlich Referenzdatei:

```bash
mkdir -p ~/.config/ga-agent/skills
cp -R examples/skills/task-collection ~/.config/ga-agent/skills/
npm run dev -- run task-collector --skill task-collection
```

Dafür müssen Modell und API-Key eingerichtet sein. Der gemeinsame Runner lädt
und validiert den explizit gewählten Skill im Laufzeitkontext. Der vereinfachte
`task-collector` verwendet ihn vorerst nicht und sendet weiterhin nur seinen
Markdown-Prompt. Skill-Katalog, Anweisungen und Referenz-Tools bleiben für
zukünftige Tool-Agents über die gemeinsamen Helper verfügbar. Skills sind keine
ausführbaren JavaScript-Plugins.

### Anbindung zukünftiger Agents

Neue Agents benötigen lediglich eine Markdown-Datei im Konfigurationsverzeichnis.
`loadAgents()` aus `src/agents/index.ts` liefert validierte Definitionen. Die CLI
löst deren `model`-Referenz über `config.models` auf und erzeugt mit
`createAgentGraph(instructions)` aus `src/agents/graph.ts` den gemeinsamen Graphen.
Der interne `AgentDefinition`-Vertrag bleibt für die Laufzeit und isolierte Tests
bestehen; er ist keine statische Registrierung von CLI-Agents.
`runAgent` stellt pro Ausführung über `runtime.context` bereit:

- `model`: das für diesen Lauf erzeugte LangChain-Chatmodell, unabhängig vom Provider.
- `skills`: gemeinsamer Zugriff über `list()`, `load(name)` und
  `readFile(name, relativePath)`.
- `activeSkill`: die vollständigen Daten des explizit aktivierten Skills,
  andernfalls `undefined`.
- `mcpTools`: ausführbare Tools aller aktivierten MCP-Server, ohne Zugangsdaten;
  bei `mcp: false` eine leere Liste.

Die CLI übergibt `modelConfig` und die geladenen `mcpServers` an `runAgent`.
Direkte Aufrufer übergeben diese ebenfalls ausdrücklich. Für Offline-Tests kann
statt `modelConfig` ein LangChain-Modell über `model` injiziert werden. Der Runner
initialisiert keine globalen Modelle und liefert weiterhin `{ message: string }`.

Tool-Agents können `createAgentSupport(context)` aus `src/agents/tools.ts` verwenden.
Der Helper kombiniert die bestehende Skill-Unterstützung mit MCP und liefert:

- `prompt`: Skill-Katalog aus Namen und Beschreibungen; bei expliziter
  Aktivierung zusätzlich die geladenen Anweisungen. Ohne Skills ein leerer String.
- `tools`: `load_skill` für vollständige Anweisungen samt Basisverzeichnis
  und `read_skill_file` für ergänzende Textdateien sowie alle `mcpTools`.
  Ohne installierte Skills entfallen nur die Skill-Tools. Ohne Skills und MCP
  ist die Liste leer. Finale Tool-Namen werden auf Kollisionen geprüft.

`createSkillSupport` aus `src/skills/tools.ts` bleibt als reiner Skill-Helper verfügbar.

Ein Tool-Graph ergänzt damit seinen Prompt, bindet die Tools an das Modell und
führt deren Aufrufe im Graphen aus. Der gemeinsame Markdown-Agent-Graph enthält
stattdessen nur einen Modellknoten ohne Tool-Binding. Eine Tool-Schleife ist noch
nicht implementiert. Modell, Skills und MCP-Zugriff
liegen im Laufzeitkontext, nicht im fachlichen Graph-Zustand.

Weitere Provider werden in `src/llm/` mit eigenem Adapter ergänzt und in der
Factory sowie dem Modell-Konfigurationsschema registriert. Agenten verwenden
weiterhin die LangChain-Schnittstelle und benötigen keinen Provider-spezifischen Code.

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
    index.ts               # Markdown-Discovery und Frontmatter-Validierung
    graph.ts               # Gemeinsamer einzelner Modellaufruf ohne Tools
    runtime.ts             # Gemeinsamer Runner und LangGraph-Kontext
    tools.ts               # Gemeinsame Skill- und MCP-Tool-Liste
  llm/
    index.ts               # Zentrale Provider-unabhängige Modell-Factory
    openrouter.ts          # OpenRouter, Request-Limit und sichere Fehler
  mcp/
    index.ts               # SDK-Verbindungen, LangChain-Tools und Cleanup
    oauth.ts               # Browser-Login, Callback, Refresh und Logout
    credentials.ts         # Geschützte atomare Ablage und Refresh-Sperren
  skills/
    index.ts               # Discovery, Formatprüfung und Dateizugriff
    tools.ts               # Prompt-Katalog und LangChain-Tools
examples/
  config.json              # Benannte Modelle und globale MCP-Konfiguration
  agents/task-collector.md  # Beispiel-Agent mit Modellprofilreferenz
  .env.example             # API-Key-Vorlage, keine echten Zugangsdaten
  skills/task-collection/  # Beispiel-Skill mit Referenzdatei
tests/
  cli.test.ts
  config.test.ts
  llm.test.ts
  agent-models.test.ts
  agents.test.ts
  task-collector.test.ts
  skills.test.ts
  agent-skills.test.ts
  mcp.test.ts
  oauth.test.ts
  mcp-cli.test.ts
  fixtures/                # Lokaler stdio-Testserver und CLI-Modellantworten
  helpers/                 # Lokaler HTTP-/OAuth-Testserver und Fake-Chatmodell
```

Die Ausführungskette ist:

```text
CLI → .env → Konfiguration/Agent-Prüfung → Skills → Modell → LangGraph → Ausgabe
```

Der `task-collector` führt ausschließlich `START → model → END` aus.
MCP-Initialisierung und -Cleanup werden für diesen Agenten übersprungen.
Es gibt keine Tool-Schleife und kein persistentes Memory.

Technik: TypeScript 7 mit ESM, LangGraph mit LangChain Core und dem dedizierten
OpenRouter-Adapter, MCP SDK mit LangChain-MCP-Tool-Adapter, Commander, YAML, Zod,
proper-lockfile, Vitest und Oxlint. Das vollständige `langchain`-Paket ist nicht nötig.

## Prüfungen

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Die Tests verwenden temporäre Verzeichnisse statt der echten
Benutzerkonfiguration. Modellaufrufe werden mit Fake-Chatmodellen oder simulierten
OpenRouter-HTTP-Antworten geprüft, auch in separaten CLI-Prozessen. Externe
Anfragen sind dabei blockiert; LangSmith-Tracing ist in den Tests deaktiviert.
Die MCP-/OAuth-Tests verwenden ausschließlich lokale Testserver und einen
simulierten Browserstart, keine externen Dienste, echten Logins oder API-Keys.
Geprüft werden Markdown-Discovery, Validierung, Migration, neue Agents ohne Build,
Prompt- und Modellwechsel sowie parallele Agents mit isolierten Einstellungen.
Hinzu kommen genau ein Modellaufruf ohne Tool-Binding oder MCP-Verbindungen für
den `task-collector`, begrenzte Retries, Timeouts, sichere
Fehlermeldungen und SIGINT/SIGTERM. Die MCP-Infrastruktur wird separat geprüft,
einschließlich Cleanup bei Modellfehlern und Abbruch.

Ein optionaler Live-Smoke-Test ist nach Einrichtung von Modell und Key mit
`npm run dev -- run task-collector` möglich. Er ist nicht Teil von `npm test`,
sendet Daten an OpenRouter und kann Kosten verursachen.
