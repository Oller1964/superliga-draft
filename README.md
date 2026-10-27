# Superliga Draft

Web-app til en Superliga-liga med vennerne. Hver uge drafter alle 7 spillere (1 målmand, 2 forsvarere, 2 midtbane, 2 angribere). Hver spiller kan kun være på ét hold, og der er ingen budget: balancen kommer fra snake-rækkefølgen, og det dårligste hold vælger først næste uge. Holdene får fantasy-point efter weekendens runde, og der er en samlet stilling for hele sæsonen. Appen kan installeres på telefonen via "Føj til hjemmeskærm".

## Sådan er den bygget

| Del | Hvor |
| --- | --- |
| Siden | GitHub Pages (`index.html`, `style.css`, `app.js`) |
| Login og database | Firebase Authentication + Firestore (`firebase-config.js`, `firestore.rules`) |
| Form og sæsontal | `data/priser.json` |
| Rundernes tal | `data/runder.json` |
| Ugens kampe | `data/kampe.json` |
| Skader og karantæner | `data/skader.json` |
| Ugentlig opdatering | `scripts/opdater.py` (køres hver tirsdag) |

## Opsætning

1. **Firebase:** Opret et projekt, slå *Email/Password* og *Google* til under Authentication, og opret en Firestore-database (production mode, `eur3`).
2. **Konfiguration:** Kopiér `firebaseConfig` fra Project settings → Your apps → Web app ind i `firebase-config.js`.
3. **Databaseregler:** Kopiér indholdet af `firestore.rules` ind under Firestore → Rules, og tryk *Publish*.
4. **Godkendt domæne:** Under Authentication → Settings → Authorized domains tilføjes `<brugernavn>.github.io`.
5. **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / root.

## Ligaer

Alle kan oprette deres egen liga med et unikt navn og en kode. Andre finder ligaen ved at søge på navnet og kommer kun ind med koden. Uden kode kan man se ligaens navn i søgningen, men ikke hold, picks eller stilling. Det håndhæves af `firestore.rules`. Den, der opretter en liga, er ejer, kan skifte koden og starte ugens draft under ⚙. Man kan være med i flere ligaer og skifte mellem dem med ⇄.

Form og rundetal (`data/`) er fælles for alle ligaer.

## Ugentlig opdatering

```bash
python3 scripts/opdater.py --stats stats/ --resultater resultater.json
```

`stats/<KLUB>.csv` har én linje pr. spiller: `navn;pos;kampe;mål;assists;gule;røde;minutter`.
`resultater.json` er `{"FCK": 0, "AGF": 2, ...}` med mål lukket ind i rundens kampe.
Scriptet tilføjer runden til `data/runder.json` og opdaterer spillernes form (vises som 0-100 i appen; feltet hedder stadig `pris` i filen og flytter sig højst 0,5 pr. uge).

## Point

- Spillet: 1. Mindst 60 minutter: +1.
- Mål: 6 (målmand og forsvar), 5 (midtbane), 4 (angreb).
- Assist: 3.
- Clean sheet (mindst 60 min.): 4 (målmand og forsvar), 1 (midtbane).
- Gult kort −1, rødt kort −3.
- Kaptajnen giver dobbelt point (vælges indtil fredag kl. 18).
