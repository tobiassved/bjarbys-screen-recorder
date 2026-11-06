# Bjarbys skärminspelare — Windows-prototyp

En Electron-port av macOS-appen. Samma idé: **inspelningen sparas som data** — skärmen *utan*
markör, ljudspåren var för sig, kameran, mus- och klickhändelser — och all polish (zoom på klick,
markör, bakgrund, klipp) läggs på i efterhand och går att ändra. Inget bränns in under inspelning.

> **Status: prototyp.** Logiken och hela kedjan är provad på Linux (se nedan). Det som bara finns på
> Windows — skärmfångst med dold markör, datorljud, fönsterinspelning, musroken — är skrivet men
> **ännu inte provkört på en Windows-dator**. Testlistan längre ner säger vad som ska kontrolleras.

## Köra

Kräver Node 22+ på Windows 10 (2004+) eller 11.

```bash
cd windows
npm install        # hämtar Electron, ffmpeg-static (MP4/GIF-export) och uiohook-napi (klick)
npm start
```

Installationsfil (`.exe`): `npm run dist` på en Windows-dator, eller kör arbetsflödet
**Windows-prototyp** under *Actions* — det bygger på en Windows-maskin och lägger `.exe` som artefakt.

- **Ctrl+Skift+R** startar/stoppar, **Ctrl+Skift+P** pausar. Appen bor också i systemfältet.
- Inspelningar hamnar i `Videor\Bjarbys skärminspelare\*.bsrec` (byt med `BJARBYS_BIBLIOTEK`).

## Vad som finns

| Funktion | Windows-prototypen |
|---|---|
| Spela in hel skärm eller ett fönster | ✓ (`getDisplayMedia`, Windows Graphics Capture) |
| Markören utanför bilden (läggs på i efterhand) | ✓ om fångsten respekterar `cursor: 'never'`, annars avstängd + varning |
| Mikrofon (eko-/brusreducering) och datorljud som egna spår | ✓ (loopback) |
| Kamera som eget spår, bubbla i bilden | ✓ |
| Mus, klick och kortkommandon som händelser (ingen vanlig text) | ✓ (`uiohook-napi`; utan den bara rörelse) |
| Flytande HUD med nedräkning, paus, stopp — utesluten ur fångsten | ✓ (`setContentProtection`) |
| Krasch­säker skrivning (bitar varje sekund), återställning av avbrutna paket | ✓ |
| Redigerare: automatisk zoom på klick, fjäderrörelse, egna zoomar (dra/ändra) | ✓ |
| Markör med klickeffekt, kortkommandon i bild, kamerabubbla | ✓ |
| Bakgrund, marginal, rundade hörn, skugga, format 16:9 / 1:1 / 9:16 / 4:3 | ✓ |
| Klipp: dela, ta bort, trimma, hastighet per del | ✓ |
| Export MP4 / WebM / GIF | ✓ (realtid, se nedan) |
| Bibliotek, byt namn, papperskorg | ✓ |

**Inte portat än** (finns i macOS-appen): transkribering och undertexter (whisper.cpp), dubbning,
maskering av känslig text, bildlager/pilar, kapitel, MCP-server och AI-producenten, insticksprogram,
uppladdning till YouTube/Dropbox/S3, flashback-buffert, penna, teleprompter, flera skärmar,
HDR, områdesinspelning, appljud per app, ProRes/AV1/FCPXML.

## Så hänger det ihop

```
main.js            huvudprocessen: fönster, källor, filskrivning, ffmpeg, bibliotek, app://-protokoll
input.js           mus + kortkommandon på inspelningens tidslinje
preload.cjs        den smala bryggan (window.api) — inget annat når Node
lib/               ren logik, delad av redigerare och prov (port av RecorderKit/Motion + Project)
  spring.js          analytisk fjäder (samma tal som Spring.swift)
  cursorpath.js      markörbanan i 240 Hz
  viewtrack.js       zoomplan + kamerabana i 120 Hz
  timemap.js         klipp och hastighet
  project.js         project.json med «saknat fält → standard»
renderer/          index (källor + bibliotek) · hud · recorder · editor · render
test/              enhetsprov, Chromium-prov av redigeraren, rökprov i Electron
```

Formatet är macOS-appens `.bsrec` (se `../docs/FORMAT.md`): `recording/` med rådata, `project.json`
med besluten, händelserna som `events.jsonl` med samma fält. Skillnaden: spåren är **WebM**
(VP9/Opus) i stället för MOV, och musens koordinater är Windows **DIP** (skalade punkter) så att
skärmskalning (125 %, 150 %) inte spelar roll.

Fällor som följt med från macOS-appen: ett nytt fält i `project.json` får aldrig göra gamla projekt
oläsbara (`normalize` + provet), ett glapp > 0,1 s mellan musrörelser betyder att musen stod
still (ingen interpolation), och förrenderat/uträknat ligger i tabeller som förhandsvisning och
export delar.

### Exporten går i realtid
Redigeraren spelar upp den färdiga bilden och ljudet mot en egen canvas och spelar in den
(`MediaRecorder`); ffmpeg gör MP4/GIF av resultatet. En film på 5 min tar alltså ~5 min att
exportera, och fönstret måste vara synligt. Det håller för en prototyp; nästa steg är bildruta för
bildruta med WebCodecs (snabbare än realtid, exakt takt).

## Prov

```bash
npm test                                   # 13 enhetsprov i lib/ (inget behövs)
npm run e2e                                # redigeraren i Chromium med ett syntetiskt paket (kräver ffmpeg + playwright)
xvfb-run -a npm run smoke                  # hela appen i Electron: spela in, spara, öppna redigeraren (Linux)
```

Provet `e2e` skriver ut bilder (rutor före/under/efter zoom, 9:16, hela redigeraren) i en mapp.

## Att kontrollera på en Windows-dator (testlista)

Det här är det som inte gick att prova utan Windows. Bocka av eller rätta i koden:

1. **Markören dold i fångsten.** Spela in 5 s och öppna redigeraren. Syns en markör i *själva
   filmen* (dubbel markör)? Då sätter appen `cursorBaked` och döljer sin egen — notera i så fall
   att `cursor: 'never'` inte respekterades av Electron/Chromium på den här versionen (på Linux/X11
   gör det inte det). Alternativ: ta över fångsten med `windows-capture`/WGC i en inbyggd modul.
2. **Datorljud.** Spela upp musik under inspelningen: kommer `system.webm` med och är synkad mot
   bilden i redigeraren?
3. **Mikrofon + kamera** med och utan «Rensa mikrofonen».
4. **HUD och nedräkning syns inte i filmen** (`WDA_EXCLUDEFROMCAPTURE`, Windows 10 2004+). På
   äldre Windows blir fönstret en svart ruta.
5. **Skärmskalning 125 / 150 %** och **två skärmar**: hamnar markör och klick-zoom på rätt
   ställe? (Koordinaterna är DIP.)
6. **Fönsterinspelning.** Fönstrets ram läses en gång vid start (PowerShell + `GetWindowRect`, med
   7 px osynlig kant på Windows 10/11) och följer inte med om fönstret flyttas.
7. **Klick och kortkommandon** (`uiohook-napi`): kommer Ctrl+S med som «Ctrl+S» i bild, och
   skrivs *vanlig text aldrig* ned i `events.jsonl`?
8. **Ctrl+Skift+R / Ctrl+Skift+P** när ett annat program har fokus.
9. **Export MP4** och spela filen i Filmer & TV / VLC: bild, ljud, A/V-synk (jfr
   `../scripts/sync-check.sh` på macOS).
10. **Krasch**: döda `electron.exe` mitt i en inspelning, starta om: dyker paketet upp som
    «återställd»?

## Säkerhet

Fönstren körs med `contextIsolation`, `sandbox`, strikt CSP och en smal brygga. Filer läses bara via
`app://local/…` från `renderer/` och `lib/` (programmet) och via paketnamn + fast lista av spårfiler
(inspelningar); paketnamn kontrolleras mot biblioteksmappen. Inga nätverksanrop görs av appen
(modellnedladdning, uppladdning och MCP är inte portade). Beroenden: `electron`, `ffmpeg-static`
(hämtar en ffmpeg-binär från GitHub vid `npm install`) och `uiohook-napi` (förbyggd `.node`-fil,
global mus-/tangentkrok); alla är fastlåsta i `package-lock.json`. Appen är inte kodsignerad, så
Windows SmartScreen varnar vid första start.
