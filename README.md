# Taxi Hyp — urmărirea taxiurilor în timp real

Aplicație web pentru o firmă de taxi. Arată pe hartă, în timp real, unde se află fiecare mașină și îi permite clientului să vadă taxiul venind spre el. Păstrează istoricul curselor, cu traseul parcurs, și permite administrarea flotei.

| Pagina | Adresa | Pentru cine | Ce face |
| --- | --- | --- | --- |
| **Hartă (dispecerat)** | `/` | dispecer (cu parolă) | Toate mașinile pe hartă, actualizate live (liber / ocupat / deconectat, direcție, viteză, traseu recent). Creează curse: adresa (căutare sau click pe hartă), clientul, mașina liberă cea mai apropiată. Generează linkul de urmărire pentru client. |
| **Istoric** | `/history` | dispecer | Cursele pe orice perioadă, cu filtre (mașină, status, client / telefon / adresă). Statistici: număr de curse, anulări, km cu clienți, timpul mediu de așteptare și durata medie. Totaluri pe mașină și șofer. Traseul GPS al fiecărei curse pe hartă. Export pentru Excel. |
| **Flotă** | `/fleet` | dispecer | Adaugă și modifică mașini și șoferi, schimbă PIN-uri, dezactivează mașini. |
| **Șofer** | `/driver` | șofer, pe telefon (mașină + PIN) | Trimite poziția GPS a telefonului, comută Liber / Ocupat, primește cursa cu sunet și vibrație, navigare cu Google Maps / Waze, butoane „Am ajuns”, „Client preluat”, „Cursă finalizată”. |
| **Client** | `/track/<cod>` | clientul (link primit prin SMS) | Vede mașina apropiindu-se pe hartă, distanța și timpul estimat, numărul de înmatriculare, modelul și prenumele șoferului. |

Poziția trimisă de telefonul șoferului ajunge în mai puțin de o secundă la dispecerat și la client (WebSocket).

## Pornire rapidă

Aveți nevoie de [Node.js](https://nodejs.org) 22 sau mai nou.

```bash
npm install
```

```bash
npm start
```

Deschideți <http://localhost:3000> și intrați cu parola de test `dispecer`.

La prima pornire se creează baza de date `data/taxi.db` și se importă cele 5 mașini demo din [`data/cars.json`](data/cars.json). După aceea, flota se administrează din pagina **Flotă**.

Ca să vedeți mașini în mișcare fără telefoane reale, porniți simulatorul într-un al doilea terminal:

```bash
npm run simulate
```

Mașinile demo circulă prin București pe străzi reale. Creați o cursă din tabul **+ Cursă nouă**, apoi deschideți linkul clientului. Mașina aleasă merge la client, îl preia și îl duce la destinație. Opțiuni: `-- --speed 3` (demo accelerat), `-- --cars 3` (doar 3 mașini), `-- --straight` (fără rutare pe străzi). Simulatorul folosește PIN-urile din `data/cars.json`.

Pagina șoferului se poate testa pe același calculator la <http://localhost:3000/driver> (ex. mașina `B 101 TXI`, PIN `1111`). Browserul va cere permisiunea pentru locație.

## Flota și șoferii

Din pagina **Flotă**:

- **Adăugare mașină**: număr de înmatriculare, model, numele șoferului și un PIN (generat automat sau ales). PIN-ul se afișează o singură dată, ca să-l comunicați șoferului; în baza de date se păstrează doar criptat (hash).
- **Modificare**: numărul, modelul și șoferul se pot schimba oricând. În istoric rămân numărul și șoferul de la momentul fiecărei curse.
- **PIN nou**: șoferul este deconectat imediat și trebuie să intre cu PIN-ul nou (ex. când un telefon se pierde sau se schimbă șoferul).
- **Dezactivare**: mașina dispare de pe hartă și din lista șoferilor, iar sesiunea șoferului se închide. Istoricul ei rămâne și poate fi reactivată. O mașină cu cursă activă nu se poate dezactiva.

**Schimbați PIN-urile demo (`1111`…`5555`) sau ștergeți mașinile demo înainte de folosire reală.**

## Configurare

Setările sunt variabile de mediu:

| Variabilă | Implicit | Descriere |
| --- | --- | --- |
| `DISPATCHER_PASSWORD` | `dispecer` (doar în dezvoltare) | Parola dispeceratului. **Obligatorie** când `NODE_ENV=production`. |
| `PORT` | `3000` | Portul serverului. |
| `COMPANY_NAME` | `Taxi Hyp` | Numele afișat pe pagini și în SMS. |
| `DATABASE_FILE` | `data/taxi.db` | Fișierul bazei de date (SQLite). |
| `CARS_FILE` | `data/cars.json` | Flota inițială, importată doar la prima pornire (când baza de date nu are mașini). |
| `ROUTE_RETENTION_DAYS` | `180` | După câte zile se șterg traseele GPS. Cursele rămân în istoric. |
| `MAP_CENTER_LAT`, `MAP_CENTER_LNG`, `MAP_ZOOM` | București, 13 | Centrul inițial al hărții (folosit și de simulator). |
| `GEOCODE_COUNTRY` | `ro` | Țara în care se caută adresele (gol = oriunde). |
| `AVG_SPEED_KMH` | `25` | Viteza medie în oraș pentru timpul estimat de sosire. |
| `TRUST_PROXY` | — | `1` dacă aplicația rulează în spatele unui reverse proxy (nginx, Caddy). |

## Date și copii de siguranță

Toate datele sunt într-un singur fișier, `data/taxi.db` (SQLite; nu e nevoie de un server de baze de date separat):

- **Flota**: mașini, șoferi, PIN-uri (criptate), ultima poziție cunoscută.
- **Cursele**: client, adresă, mașină, șofer, ora fiecărei etape și km parcurși cu clientul.
- **Traseele**: câte un punct GPS la 10 secunde pe durata fiecărei curse.

La repornirea serverului nu se pierde nimic: cursele în desfășurare continuă, iar linkurile clienților rămân valabile. Telefoanele șoferilor se reconectează singure.

O copie de siguranță se face cu serverul pornit:

```bash
npm run backup
```

Copia se salvează în `data/backups/`. Programați comanda zilnic (ex. cu `cron`) și păstrați copiile și pe alt calculator.

## Folosire cu telefoane reale (HTTPS obligatoriu)

Browserele dau acces la GPS **doar pe pagini HTTPS** (excepție: `localhost`). Pentru șoferi, aplicația trebuie deci publicată pe un domeniu cu HTTPS.

**Pe un server (VPS)** cu [Caddy](https://caddyserver.com), care obține automat certificatul:

```
taxi.firma-mea.ro {
    reverse_proxy localhost:3000
}
```

Apoi porniți aplicația cu Docker. Baza de date stă pe volumul `taxi-data`, deci rămâne și la actualizarea aplicației:

```bash
docker build -t taxi-hyp .
```

```bash
docker run -d --restart unless-stopped -p 3000:3000 -e DISPATCHER_PASSWORD='o-parola-lunga' -e TRUST_PROXY=1 -v taxi-data:/app/data taxi-hyp
```

**Pentru un test rapid**, fără server, un tunel temporar oferă o adresă HTTPS către calculatorul dvs.:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

**Important pentru șoferi:** pagina trebuie să rămână deschisă pe ecran în timpul turei. Browserele de pe telefon opresc GPS-ul când pagina trece în fundal sau ecranul se stinge (aplicația cere ca ecranul să rămână aprins acolo unde browserul permite).

## Cum funcționează

```
 Telefon șofer ──GPS──▶  Server Node.js  ──live──▶  Dispecerat (toate mașinile)
   /driver       ◀─curse─  (Socket.IO)    ──live──▶  Client /track/<cod> (doar mașina lui)
                              │
                         data/taxi.db  ◀── Istoric și Flotă (/history, /fleet)
```

- **Server**: Express + Socket.IO ([`src/app.js`](src/app.js)). Logica flotei și a curselor e în [`src/store.js`](src/store.js), iar baza de date în [`src/db.js`](src/db.js).
- **Hărți**: [Leaflet](https://leafletjs.com) cu hărți [OpenStreetMap](https://www.openstreetmap.org), fără cheie API. Căutarea adreselor folosește [Nominatim](https://nominatim.org).
- **Securitate**: dispeceratul are parolă, fiecare șofer are PIN (păstrat doar ca hash scrypt), iar încercările greșite repetate sunt blocate temporar. Linkul clientului conține un cod aleatoriu de 128 de biți și arată doar mașina cursei respective, fără datele altor clienți. Linkul expiră la o zi după încheierea cursei, iar poziția mașinii nu mai este arătată după încheiere.
- **Kilometrajul** se calculează doar cu clientul în mașină. Pozițiile GPS imprecise și salturile imposibile sunt ignorate.
- **Statusurile cursei**: `Mașină în drum` → `Mașina a sosit` → `În cursă` → `Finalizată` (sau `Anulată` de dispecerat).

## Teste

```bash
npm test
```

Testele verifică logica flotei și a curselor, baza de date (inclusiv repornirea serverului în timpul unei curse), istoricul și statisticile, administrarea flotei, plus un flux complet prin WebSocket și API: șoferul se conectează, dispeceratul trimite cursa, clientul urmărește mașina până la final.

## Limitări actuale și pași următori

- **O singură parolă de dispecerat.** Pentru mai mulți dispeceri: conturi individuale și jurnal cu cine ce a făcut.
- **Un singur server.** SQLite e potrivit pentru o firmă cu zeci de mașini pe un server. Pentru mai multe servere în paralel ar fi nevoie de PostgreSQL și de un adaptor Socket.IO (ex. Redis).
- **GPS în fundal:** o aplicație mobilă nativă (sau un wrapper ca Capacitor) ar transmite poziția și cu ecranul stins.
- **Timpul estimat** se calculează din distanța în linie dreaptă, cu un factor pentru străzi. Pentru precizie mai mare se poate folosi un serviciu de rutare (OSRM, Google, Mapbox).
- **Serviciile OpenStreetMap gratuite** (hărți, Nominatim, rutarea din simulator) au limite de utilizare echitabilă. La trafic mare folosiți un furnizor comercial sau propriul server de hărți.
