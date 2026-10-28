# Taxi Hyp — urmărirea taxiurilor în timp real

Aplicație web pentru o firmă de taxi. Arată pe hartă, în timp real, unde se află fiecare mașină și îi permite clientului să vadă taxiul venind spre el.

Are trei pagini:

| Pagina | Adresa | Pentru cine | Ce face |
| --- | --- | --- | --- |
| **Dispecerat** | `/` | dispecer (cu parolă) | Toate mașinile pe hartă, actualizate live (liber / ocupat / deconectat, direcție, viteză, traseu recent). Creează curse: adresa (căutare sau click pe hartă), clientul, mașina liberă cea mai apropiată. Generează linkul de urmărire pentru client. |
| **Șofer** | `/driver` | șofer, pe telefon (mașină + PIN) | Trimite poziția GPS a telefonului, comută Liber / Ocupat, primește cursa cu sunet și vibrație, navigare cu Google Maps / Waze, butoane „Am ajuns”, „Client preluat”, „Cursă finalizată”. |
| **Client** | `/track/<cod>` | clientul (link primit prin SMS) | Vede mașina apropiindu-se pe hartă, distanța și timpul estimat, numărul de înmatriculare, modelul și prenumele șoferului. Linkul nu mai arată poziția mașinii după încheierea cursei. |

Poziția trimisă de telefonul șoferului ajunge în mai puțin de o secundă la dispecerat și la client (WebSocket).

## Pornire rapidă

Aveți nevoie de [Node.js](https://nodejs.org) 18 sau mai nou.

```bash
npm install
```

```bash
npm start
```

Deschideți <http://localhost:3000> și intrați cu parola de test `dispecer`.

Ca să vedeți mașini în mișcare fără telefoane reale, porniți simulatorul într-un al doilea terminal:

```bash
npm run simulate
```

Cele 5 mașini demo circulă prin București pe străzi reale. Creați o cursă din tabul **+ Cursă nouă**, apoi deschideți linkul clientului. Mașina aleasă merge la client, îl preia și îl duce la destinație. Opțiuni: `-- --cars 3` (doar 3 mașini), `-- --straight` (fără rutare pe străzi).

Pagina șoferului se poate testa pe același calculator la <http://localhost:3000/driver> (ex. mașina `B 101 TXI`, PIN `1111`). Browserul va cere permisiunea pentru locație.

## Configurare

Mașinile se definesc în [`data/cars.json`](data/cars.json): `id`, `plate` (nr. înmatriculare), `model`, `driver` (nume șofer) și `pin` (codul cu care șoferul intră în aplicație). **Schimbați PIN-urile demo înainte de folosire reală.**

Restul setărilor sunt variabile de mediu:

| Variabilă | Implicit | Descriere |
| --- | --- | --- |
| `DISPATCHER_PASSWORD` | `dispecer` (doar în dezvoltare) | Parola dispeceratului. **Obligatorie** când `NODE_ENV=production`. |
| `PORT` | `3000` | Portul serverului. |
| `COMPANY_NAME` | `Taxi Hyp` | Numele afișat pe pagini și în SMS. |
| `CARS_FILE` | `data/cars.json` | Fișierul cu flota. |
| `MAP_CENTER_LAT`, `MAP_CENTER_LNG`, `MAP_ZOOM` | București, 13 | Centrul inițial al hărții (folosit și de simulator). |
| `GEOCODE_COUNTRY` | `ro` | Țara în care se caută adresele (gol = oriunde). |
| `AVG_SPEED_KMH` | `25` | Viteza medie în oraș pentru timpul estimat de sosire. |
| `TRUST_PROXY` | — | `1` dacă aplicația rulează în spatele unui reverse proxy (nginx, Caddy). |

## Folosire cu telefoane reale (HTTPS obligatoriu)

Browserele dau acces la GPS **doar pe pagini HTTPS** (excepție: `localhost`). Pentru șoferi, aplicația trebuie deci publicată pe un domeniu cu HTTPS.

**Pe un server (VPS)** cu [Caddy](https://caddyserver.com), care obține automat certificatul:

```
taxi.firma-mea.ro {
    reverse_proxy localhost:3000
}
```

Apoi porniți aplicația cu Docker:

```bash
docker build -t taxi-hyp .
```

```bash
docker run -d --restart unless-stopped -p 3000:3000 -e DISPATCHER_PASSWORD='o-parola-lunga' -e TRUST_PROXY=1 -v "$PWD/data:/app/data:ro" taxi-hyp
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
```

- **Server**: Express + Socket.IO ([`src/app.js`](src/app.js)). Starea flotei și a curselor e în [`src/store.js`](src/store.js).
- **Hărți**: [Leaflet](https://leafletjs.com) cu hărți [OpenStreetMap](https://www.openstreetmap.org), fără cheie API. Căutarea adreselor folosește [Nominatim](https://nominatim.org).
- **Securitate**: dispeceratul are parolă, fiecare șofer are PIN, iar încercările greșite repetate sunt blocate temporar. Linkul clientului conține un cod aleatoriu de 128 biți și arată doar mașina cursei respective, fără datele altor clienți.
- **Statusurile cursei**: `Mașină în drum` → `Mașina a sosit` → `În cursă` → `Finalizată` (sau `Anulată` de dispecerat).

## Teste

```bash
npm test
```

Testele verifică logica flotei și a curselor, plus un flux complet prin WebSocket: șoferul se conectează, dispeceratul trimite cursa, clientul urmărește mașina până la final.

## Limitări actuale și pași următori

- **Datele sunt ținute în memorie.** La repornirea serverului se pierd cursele (mașinile reapar când telefoanele se reconectează). Pasul următor: o bază de date (ex. PostgreSQL) și istoricul curselor.
- **Șoferii și PIN-urile sunt într-un fișier.** Pentru o flotă mai mare: conturi de utilizator și administrarea flotei din interfață.
- **GPS în fundal:** o aplicație mobilă nativă (sau un wrapper ca Capacitor) ar transmite poziția și cu ecranul stins.
- **Timpul estimat** se calculează din distanța în linie dreaptă, cu un factor pentru străzi. Pentru precizie mai mare se poate folosi un serviciu de rutare (OSRM, Google, Mapbox).
- **Serviciile OpenStreetMap gratuite** (hărți, Nominatim, rutarea din simulator) au limite de utilizare echitabilă. La trafic mare folosiți un furnizor comercial sau propriul server de hărți.
