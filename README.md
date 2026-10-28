# Taxi Hyp — urmărirea taxiurilor în timp real

Aplicație web pentru o firmă de taxi. Arată pe hartă, în timp real, unde se află fiecare mașină. Dispecerul trimite comenzile la șoferi, iar clientul primește prin SMS un link în care vede taxiul venind spre el. Păstrează istoricul curselor, cu traseul parcurs, permite administrarea flotei și a conturilor, iar un jurnal arată cine ce a făcut.

| Pagina | Adresa | Pentru cine | Ce face |
| --- | --- | --- | --- |
| **Hartă** | `/` | dispeceri | Toate mașinile pe hartă, actualizate live (liber / ocupat / deconectat, direcție, viteză, traseu recent). Preia comenzile: adresa (căutare sau click pe hartă), clientul, telefonul (opțional completate automat din convorbire, de un [asistent vocal cu AI local](#asistent-vocal-comanda-completată-din-convorbire-ai-local)); comanda pleacă la toți șoferii liberi, la cei mai apropiați sau la o anumită mașină. Arată cine a acceptat sau a refuzat și dacă SMS-ul a ajuns la client. |
| **Istoric** | `/history` | dispeceri | Cursele pe orice perioadă, cu filtre (mașină, status, client / telefon / adresă). Statistici: număr de curse, anulări, comenzi fără șofer, km cu clienți, timpul mediu până la acceptare, de așteptare și durata medie. Totaluri pe mașină și șofer, respectiv pe dispecer. Traseul GPS al fiecărei curse pe hartă. Export pentru Excel. |
| **Flotă** | `/fleet` | administratori | Adaugă și modifică mașini și șoferi, schimbă PIN-uri, dezactivează mașini. |
| **Utilizatori** | `/users` | administratori | Conturile dispecerilor și administratorilor: adăugare, rol, resetare parolă, dezactivare. |
| **Jurnal** | `/audit` | administratori | Cine ce a făcut și când: autentificări (inclusiv cele eșuate), comenzi trimise, retrimise și anulate, SMS-uri retrimise, modificări în flotă și conturi, exporturi. |
| **Șofer** | `/driver` sau **aplicația Android** | șofer, pe telefon (mașină + PIN) | Trimite poziția GPS a telefonului (obligatoriu: fără GPS nu primește comenzi), comută Liber / Ocupat, primește comenzile cu sunet și vibrație și le acceptă sau le refuză, navigare cu Google Maps / Waze, butoane „Am ajuns”, „Client preluat”, „Cursă finalizată”. Aplicația Android transmite poziția **și cu ecranul stins** și anunță comenzile noi prin notificări. |
| **Client** | `/track/<cod>` | clientul (link primit automat prin SMS) | Vede mașina apropiindu-se pe hartă, distanța și timpul estimat, numărul de înmatriculare, modelul și prenumele șoferului. După încheierea cursei, linkul nu mai funcționează. |

Poziția trimisă de telefonul șoferului ajunge în mai puțin de o secundă la dispecerat și la client (WebSocket).

## Fluxul unei comenzi

1. **Clientul sună la dispecerat** și spune adresa.
2. **Dispecerul introduce comanda** (tabul **+ Cursă nouă**): caută adresa sau dă click pe hartă, completează numele și telefonul clientului și alege cui o trimite: tuturor mașinilor libere, celor mai apropiate 3 / 5 sau unei anumite mașini.
3. **Șoferii primesc comanda** (doar cei liberi și [cu GPS-ul pornit](#gps-obligatoriu)) pe telefon, cu sunet, vibrație și (în aplicația Android) notificare. Văd adresa, observațiile, distanța și timpul până la client, dar **nu și numele sau telefonul clientului**. Au 60 de secunde să răspundă.
4. **Șoferul acceptă sau refuză.** Primul care acceptă primește cursa: mașina lui devine ocupată, iar la ceilalți comanda dispare („preluată de alt coleg”). Abia acum șoferul vede numele și telefonul clientului.
   - Dacă toți refuză sau nu răspunde nimeni, dispecerul vede un avertisment și poate **retrimite** comanda (eventual altor mașini) sau o poate **anula**.
5. **Clientul primește automat un SMS** cu linkul de urmărire, de exemplu:
   > Taxi Hyp: Taxiul B 105 TXI (Hyundai Ioniq, sofer Mihai) vine spre dvs., ajunge in cca 3 min. Urmariti-l: https://taxi.firma-mea.ro/track/…

   În link, clientul vede pe hartă unde e taxiul, timpul estimat până la sosire, numărul de înmatriculare, modelul și prenumele șoferului. Dispecerul vede dacă SMS-ul a plecat și îl poate retrimite.
6. **Șoferul marchează etapele**: „Am ajuns”, „Client preluat”, „Cursă finalizată”.
7. **După finalizare (sau anulare), linkul dispare**: pagina deschisă la client arată „Cursa s-a încheiat”, iar la redeschidere linkul arată doar „Linkul nu mai este valabil”.

Trimiterea SMS-urilor reale se configurează în secțiunea [SMS către clienți](#sms-către-clienți).

## GPS obligatoriu

Șoferii lucrează doar cu GPS-ul pornit. Aplicația nu poate împiedica oprirea locației din setările telefonului, dar o observă imediat și are consecințe:

- **Fără GPS nu se primesc comenzi.** O mașină conectată, dar fără o poziție GPS nouă în ultimul minut, nu primește comenzi și nu poate accepta una deja primită. Comenzile deschise i se retrag.
- **Dispecerul este avertizat.** Mașina apare cu eticheta roșie „Fără GPS”, iar sus apare numărul mașinilor fără GPS. Când o mașină pierde GPS-ul, apare un avertisment, iar în timpul unei curse acesta indică și cursa respectivă. Mașinile fără GPS nu apar în lista „Trimite comanda la”.
- **Șoferul vede un avertisment roșu** cât timp GPS-ul e oprit sau fără semnal. Aplicația Android îl anunță și printr-o notificare cu sunet.
- **În timpul unei curse, GPS-ul nu poate fi oprit**: butonul „Oprește GPS” / „Încheie tura” este blocat până la finalizarea cursei.
- **O poziție veche nu păcălește sistemul.** Telefonul trimite și vârsta fiecărei poziții, deci retrimiterea ultimei poziții cunoscute (ex. cu locația oprită) nu ține mașina „cu GPS”.

Când telefonul raportează că locația e oprită sau accesul la ea refuzat, dispecerul află imediat. Altfel (ex. telefonul nu mai dă poziții într-o parcare subterană), mașina apare „Fără GPS” după un minut.
 Fără configurare, SMS-ul doar apare în jurnalul serverului (`[sms simulat] către +40…`).

## Pornire rapidă

Aveți nevoie de [Node.js](https://nodejs.org) 22 sau mai nou.

```bash
npm install
```

```bash
npm start
```

Deschideți <http://localhost:3000> și intrați cu utilizatorul `admin` și parola `admin`. La prima autentificare vi se cere să alegeți o parolă proprie.

La prima pornire se creează baza de date `data/taxi.db`, contul `admin` și cele 5 mașini demo din [`data/cars.json`](data/cars.json). După aceea, flota și conturile se administrează din aplicație.

Ca să vedeți mașini în mișcare fără telefoane reale, porniți simulatorul într-un al doilea terminal:

```bash
npm run simulate
```

Mașinile demo circulă prin București pe străzi reale. Trimiteți o comandă din tabul **+ Cursă nouă**: șoferii simulați o acceptă (uneori o refuză sau o ignoră), iar textul SMS-ului cu linkul clientului apare în terminalul serverului. Mașina care a acceptat merge la client, îl preia și îl duce la destinație. Opțiuni: `-- --speed 3` (demo accelerat), `-- --cars 3` (doar 3 mașini), `-- --straight` (fără rutare pe străzi). Simulatorul folosește PIN-urile din `data/cars.json`.

Pagina șoferului se poate testa pe același calculator la <http://localhost:3000/driver> (ex. mașina `B 101 TXI`, PIN `1111`). Browserul va cere permisiunea pentru locație.

## Aplicația Android pentru șoferi

Pagina `/driver` funcționează în orice browser, dar browserul oprește GPS-ul când ecranul se stinge sau șoferul deschide altă aplicație (ex. Waze). Aplicația Android din [`mobile/`](mobile) rezolvă asta:

- **Transmite poziția și cu ecranul stins** sau din alte aplicații. Cât timp tura e activă, în bara de notificări apare „Tură activă · B 101 TXI”, așa cum cere Android pentru localizarea în fundal. Tura nu se poate încheia în timpul unei curse.
- **Anunță comenzile noi** (și anulările) printr-o notificare cu sunet, chiar dacă telefonul e în buzunar. Cu aplicația deschisă, comanda apare direct pe ecran, cu butoanele **Accept** și **Refuz**.
- **Are aceeași interfață** ca pagina web: aplicația conține pagina șoferului, deci orice îmbunătățire a ei ajunge în ambele.
- **Păstrează doar un token de sesiune**, nu PIN-ul. Un PIN nou sau dezactivarea mașinii închide tura pe telefon.

### Instalare pe telefoane

1. **Descărcați APK-ul.** La fiecare modificare, GitHub Actions construiește aplicația: în repository, deschideți **Actions → CI → ultima rulare → Artifacts → `taxi-hyp-sofer-apk`**. Alternativ, construiți-l local (mai jos).
2. **Instalați-l pe telefonul șoferului.** Copiați fișierul `.apk` pe telefon și deschideți-l. Android cere permisiunea de a instala aplicații din această sursă.
3. **La prima pornire:**
   - introduceți adresa serverului firmei (ex. `https://taxi.firma-mea.ro`; serverul trebuie să aibă HTTPS);
   - alegeți mașina și introduceți PIN-ul;
   - la **Începe tura**, permiteți **locația** („în timp ce folosiți aplicația” e suficient) și **notificările**.
4. **Pe telefoanele Samsung, Xiaomi, Huawei și altele**, dezactivați „optimizarea bateriei” pentru aplicație (Setări → Aplicații → Taxi Hyp Șofer → Baterie → Nerestricționat). Altfel sistemul poate opri aplicația în timpul turei.

### Construire locală

Aveți nevoie de Node.js 22, JDK 21 și Android SDK (cel mai simplu prin [Android Studio](https://developer.android.com/studio)).

```bash
npm install
```

```bash
cd mobile && npm install
```

```bash
TAXI_SERVER_URL=https://taxi.firma-mea.ro npm run apk
```

APK-ul rezultă în `mobile/android/app/build/outputs/apk/debug/`. `TAXI_SERVER_URL` e opțional: dacă lipsește, adresa serverului se introduce în aplicație. Proiectul se poate deschide și în Android Studio (`npx cap open android`, din `mobile/`).

### Versiunea pentru distribuire (semnată)

APK-ul de test (debug) e semnat cu o cheie de dezvoltare. Pentru distribuire, creați o singură dată cheia firmei și **păstrați-o în siguranță**: actualizările aplicației trebuie semnate cu aceeași cheie.

```bash
keytool -genkeypair -v -keystore taxi-release.jks -alias taxi -keyalg RSA -keysize 2048 -validity 10000
```

- **Local:** creați `mobile/android/keystore.properties` (ignorat de git), cu `storeFile`, `storePassword`, `keyAlias`, `keyPassword`. Apoi rulați `npm run apk:release` din `mobile/`.
- **În GitHub Actions:** adăugați secretele `TAXI_KEYSTORE_BASE64` (fișierul `.jks` codat cu `base64 -w0`), `TAXI_KEYSTORE_PASSWORD`, `TAXI_KEY_ALIAS` și `TAXI_KEY_PASSWORD`. APK-ul semnat apare atunci lângă cel de test. Adresa serverului se poate fixa cu variabila de repository `TAXI_SERVER_URL`.

### Cum funcționează în fundal

Android încetinește conexiunile paginii (WebView) după câteva minute în fundal. De aceea aplicația trimite poziția prin **HTTP nativ** (`POST /api/driver/location`), la 2 secunde în mers și cel puțin la 10 secunde pe loc. Răspunsul conține comenzile primite și cursa curentă, astfel că o comandă nouă sau o anulare ajunge la șofer în cel mult ~10 secunde, chiar dacă WebSocket-ul e întrerupt. Acceptarea și refuzul se trimit tot prin HTTP. Pe server, mașina apare conectată cât timp a trimis ceva în ultimul minut.

## Conturi, roluri și jurnal

Fiecare persoană din dispecerat are contul ei (utilizator + parolă), cu unul dintre roluri:

- **Dispecer**: hartă, comenzi (trimitere, retrimitere, anulare, finalizare, retrimiterea SMS-ului), istoric și export.
- **Administrator**: în plus Flotă, Utilizatori și Jurnal.

Din pagina **Utilizatori**, administratorul:

- **Adaugă un cont**: nume, utilizator, rol. Se generează o **parolă temporară**, afișată o singură dată, pe care o comunicați persoanei. La prima autentificare, aceasta își alege propria parolă; până atunci nu poate lucra în aplicație.
- **Resetează parola** (ex. parolă uitată): persoana este deconectată imediat și primește o nouă parolă temporară.
- **Dezactivează un cont** (ex. plecare din firmă): persoana este deconectată imediat, de pe toate calculatoarele. Acțiunile ei rămân în jurnal și în istoric.

Ca să nu rămâneți fără acces, nimeni nu își poate dezactiva propriul cont sau schimba propriul rol, și rămâne mereu cel puțin un administrator activ.

Fiecare își poate schimba parola din meniul cu numele său (dreapta sus). Atunci celelalte sesiuni ale lui (alte calculatoare) se închid. Sesiunea expiră după 12 ore fără activitate (`SESSION_IDLE_HOURS`) și oricum după 7 zile.

**Jurnalul** (`/audit`) păstrează data, persoana, acțiunea, detaliile și adresa IP pentru:

- autentificări (inclusiv cele eșuate), ieșiri și schimbări de parolă;
- comenzi trimise (și la câte mașini), retrimise, anulate sau finalizate de dispecer, SMS-uri retrimise;
- mașini adăugate, modificate (inclusiv „PIN nou”, fără PIN-ul în sine), dezactivate;
- conturi create, modificate, resetate, dezactivate;
- exporturi ale istoricului (fișierul conține telefoanele clienților).

În istoric, fiecare cursă arată și dispecerul care a creat-o, cui i-a fost trimisă comanda și ce a răspuns fiecare șofer, starea SMS-ului și cine a închis cursa (șoferul sau dispecerul).

## Flota și șoferii

Din pagina **Flotă** (administratori):

- **Adăugare mașină**: număr de înmatriculare, model, numele șoferului și un PIN (generat automat sau ales). PIN-ul se afișează o singură dată, ca să-l comunicați șoferului; în baza de date se păstrează doar criptat (hash).
- **Modificare**: numărul, modelul și șoferul se pot schimba oricând. În istoric rămân numărul și șoferul de la momentul fiecărei curse.
- **PIN nou**: șoferul este deconectat imediat și trebuie să intre cu PIN-ul nou.
- **Dezactivare**: mașina dispare de pe hartă și din lista șoferilor, iar sesiunea șoferului se închide. Istoricul ei rămâne și poate fi reactivată. O mașină cu cursă activă nu se poate dezactiva.

**Schimbați PIN-urile demo (`1111`…`5555`) sau dezactivați mașinile demo înainte de folosire reală.**

## Configurare

Setările sunt variabile de mediu:

| Variabilă | Implicit | Descriere |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `admin` (doar în dezvoltare, de schimbat la prima autentificare) | Parola contului `admin`, folosită **doar la prima pornire**, când nu există niciun cont. **Obligatorie** la prima pornire cu `NODE_ENV=production`. Apoi parola se schimbă din aplicație. |
| `PORT` | `3000` | Portul serverului. |
| `COMPANY_NAME` | `Taxi Hyp` | Numele afișat pe pagini și în SMS. |
| `DATABASE_FILE` | `data/taxi.db` | Fișierul bazei de date (SQLite). |
| `CARS_FILE` | `data/cars.json` | Flota inițială, importată doar la prima pornire (când baza de date nu are mașini). |
| `SESSION_IDLE_HOURS` | `12` | După câte ore fără activitate expiră sesiunea unui dispecer. |
| `ROUTE_RETENTION_DAYS` | `180` | După câte zile se șterg traseele GPS. Cursele rămân în istoric. |
| `TIME_ZONE` | `Europe/Bucharest` | Fusul orar pentru datele scrise de server în jurnal. |
| `MAP_CENTER_LAT`, `MAP_CENTER_LNG`, `MAP_ZOOM` | București, 13 | Centrul inițial al hărții (folosit și de simulator). |
| `GEOCODE_COUNTRY` | `ro` | Țara în care se caută adresele (gol = oriunde). |
| `AVG_SPEED_KMH` | `25` | Viteza medie în oraș pentru timpul estimat de sosire. |
| `PUBLIC_URL` | adresa din browserul dispecerului | Adresa publică a serverului, folosită în linkul din SMS (ex. `https://taxi.firma-mea.ro`). **Setați-o** dacă dispecerii lucrează pe o adresă internă (ex. `http://192.168.1.10:3000`), pe care clienții nu o pot deschide. |
| `OFFER_TIMEOUT_SECONDS` | `60` | Cât timp are șoferul să accepte comanda. |
| `SMS_PROVIDER` | `console` | Cum se trimite SMS-ul clientului: `console` (doar în jurnalul serverului), `smsgate` sau `twilio`. Vezi mai jos. |
| `SMS_COUNTRY_CODE` | `40` | Prefixul țării adăugat numerelor scrise local (`0722…` → `+40722…`). |
| `VOICE_STT_URL` | — (asistent vocal oprit) | Adresa serverului de recunoaștere a vocii, **văzută de pe calculatorul dispecerului** (ex. `http://127.0.0.1:8080/inference`). Vezi [Asistent vocal](#asistent-vocal-comanda-completată-din-convorbire-ai-local). |
| `VOICE_STT_MODEL` | — | Numele modelului, doar pentru serverele compatibile OpenAI care îl cer (whisper.cpp nu). |
| `VOICE_LANGUAGE` | `ro` | Limba convorbirilor. |
| `VOICE_LLM_URL`, `VOICE_LLM_MODEL` | —, `qwen2.5:7b` | Opțional: Ollama pe calculatorul dispecerului (ex. `http://127.0.0.1:11434`), pentru ce nu prind regulile. |
| `TRUST_PROXY` | — | `1` dacă aplicația rulează în spatele unui reverse proxy (nginx, Caddy). |

## SMS către clienți

Când un șofer acceptă comanda, serverul trimite clientului SMS-ul cu linkul. Textul e scris fără diacritice, ca să încapă într-un singur SMS (160 de caractere). Dacă trimiterea eșuează (număr greșit, furnizor indisponibil), dispecerul vede eroarea lângă cursă și poate retrimite SMS-ul sau poate dicta clientului linkul (butonul îl copiază).

Alegeți un furnizor:

**1. Un telefon Android al firmei (`SMS_PROVIDER=smsgate`)** — cel mai ieftin: SMS-urile pleacă de pe cartela SIM a telefonului, la tariful abonamentului.

1. Instalați pe un telefon Android cu cartelă SIM aplicația [SMS Gateway for Android](https://sms-gate.app) și porniți **Cloud server**. Aplicația afișează un utilizator și o parolă.
2. Porniți serverul cu:

   ```bash
   SMS_PROVIDER=smsgate SMSGATE_USER=utilizator SMSGATE_PASSWORD=parola PUBLIC_URL=https://taxi.firma-mea.ro npm start
   ```

3. Lăsați telefonul pornit, încărcat și cu internet. Dezactivați „optimizarea bateriei” pentru aplicație.

Cu serverul propriu SMS Gateway (sau modul „Local server” al aplicației), setați și `SMSGATE_URL` (implicit `https://api.sms-gate.app/3rdparty/v1`).

**2. Twilio (`SMS_PROVIDER=twilio`)** — serviciu comercial, fără telefon, plătit per SMS.

| Variabilă | Descriere |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Din consola Twilio. |
| `TWILIO_FROM` | Numărul sau numele expeditorului (ex. `TaxiHyp`, unde operatorii îl permit). |
| `TWILIO_MESSAGING_SERVICE_SID` | Alternativă la `TWILIO_FROM`: un Messaging Service din Twilio. |

Dacă lipsesc datele necesare furnizorului ales, serverul nu pornește și spune ce variabilă lipsește.

## Asistent vocal: comanda completată din convorbire (AI local)

Cât timp dispecerul vorbește cu clientul, aplicația poate asculta convorbirea și completa singură formularul: adresa (căutată imediat pe hartă), numele, telefonul și observațiile (bloc, scară, bagaje). Dispecerul verifică și apasă **Trimite comanda**.

**Totul rulează pe calculatorul dispecerului**, fără servicii plătite și fără costuri per apel. Sunetul nu pleacă spre serverul firmei sau spre internet și nu se păstrează nicăieri. Rămân doar datele comenzii trimise.

Cum funcționează:

1. În tabul **+ Cursă nouă**, dispecerul apasă **Ascultă convorbirea**. Browserul cere o dată acces la microfon.
2. Pagina împarte vorbirea în fraze și le trimite la **Whisper**, un program gratuit de recunoaștere a vocii care rulează pe același calculator. Textul apare sub buton.
3. Din text, aplicația scoate adresa („strada Ion Creangă numărul 12” devine „Strada Ion Creangă 12”), blocul și scara, numele (după „pe numele…” sau ca răspuns la „Pe ce nume?”) și telefonul.
4. Opțional, un **model AI local** (Ollama) citește convorbirea și completează ce nu prind regulile, de exemplu „la Gara de Nord”.
5. Câmpurile scrise de mână de dispecer nu sunt modificate. La trimiterea comenzii, ascultarea se oprește.

**Ce se aude:** asistentul ascultă microfonul calculatorului. Cu căști, aude doar dispecerul, deci funcționează când dispecerul repetă adresa („Calea Victoriei 12, pe numele Ana Popescu, da?”), cum se face de obicei. Dacă telefonul e pe difuzor sau convorbirea se face din calculator, aude ambele voci.

### Instalare pe calculatorul dispecerului

**1. Whisper (obligatoriu)**, prin [whisper.cpp](https://github.com/ggml-org/whisper.cpp):

- **Windows:** din pagina *Releases* a whisper.cpp descărcați arhiva pentru Windows (cea cu `cublas` în nume dacă aveți placă video NVIDIA) și dezarhivați-o.
- **Linux:** compilați din sursă, conform instrucțiunilor whisper.cpp (`cmake -B build && cmake --build build --config Release`).
- **Modelul**, de pe [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main):
  - cu placă video NVIDIA: `ggml-large-v3-turbo.bin` (1,6 GB), cea mai bună recunoaștere a limbii române;
  - doar cu procesor: `ggml-small.bin` (0,5 GB), rapid, dar greșește mai des; pe un procesor puternic încercați și `ggml-medium-q5_0.bin`.
- **Pornire:**

  ```bash
  whisper-server -m ggml-small.bin -l ro --host 127.0.0.1 --port 8080
  ```

  Pe Windows, programul se numește `whisper-server.exe`. Lăsați-l pornit cât lucrează dispeceratul (ex. din *Pornire automată* în Windows).

**2. Ollama (opțional)**, de pe [ollama.com](https://ollama.com):

```bash
ollama pull qwen2.5:7b
```

Ollama acceptă implicit doar cereri de la pagini deschise pe `localhost`. Dacă dispecerii lucrează pe adresa publică, setați pe calculator variabila de mediu `OLLAMA_ORIGINS` la adresa aplicației (ex. `https://taxi.firma-mea.ro`) și reporniți Ollama. Pe procesor, un model de 7B răspunde în câteva secunde; regulile completează formularul imediat, iar Ollama corectează apoi.

**3. Pe server**, porniți aplicația cu:

```bash
VOICE_STT_URL=http://127.0.0.1:8080/inference VOICE_LLM_URL=http://127.0.0.1:11434 npm start
```

Adresele sunt cele **de pe calculatorul dispecerului** (pagina le apelează direct), nu de pe server. Folosiți `127.0.0.1`: dintr-o pagină HTTPS, browserul blochează adresele `http://` ale altor calculatoare din rețea. Așa, serverul aplicației poate fi oriunde (ex. un VPS), iar AI-ul rămâne în dispecerat. Fiecare calculator de dispecer are nevoie de Whisper-ul lui. Chrome poate cere o dată permisiunea de acces la rețeaua locală (pagina publică apelează `127.0.0.1`): alegeți **Permiteți**.

Merge și cu alte servere compatibile cu API-ul OpenAI de transcriere (ex. `…/v1/audio/transcriptions`); pentru ele setați și `VOICE_STT_MODEL`.

**Înainte de folosire:**

- **Testați** pe câteva zeci de convorbiri reale. Recunoașterea greșește uneori numele de străzi, mai ales cu modelele mici, pe procesor. Pinul de pe hartă arată imediat dacă adresa a fost înțeleasă.
- **GDPR:** clientul trebuie informat că apelul este procesat automat (ex. un mesaj la începutul apelului). Verificați formularea cu cine se ocupă de protecția datelor în firmă.

## Date și copii de siguranță

Toate datele sunt într-un singur fișier, `data/taxi.db` (SQLite; nu e nevoie de un server de baze de date separat):

- **Flota**: mașini, șoferi, PIN-uri (criptate), ultima poziție cunoscută.
- **Cursele**: client, adresă, mașină, șofer, dispecer, ora fiecărei etape (inclusiv acceptarea), km parcurși cu clientul, starea SMS-ului.
- **Comenzile trimise șoferilor**: cui, când și ce a răspuns fiecare (acceptat, refuzat, expirat, preluată de altul).
- **Traseele**: câte un punct GPS la 10 secunde pe durata fiecărei curse.
- **Conturile, sesiunile și jurnalul**: parolele și tokenurile de sesiune sunt păstrate doar ca hash.

La repornirea serverului nu se pierde nimic: comenzile care așteaptă un șofer și cursele în desfășurare continuă, linkurile clienților rămân valabile, iar dispecerii rămân autentificați. Telefoanele șoferilor se reconectează singure.

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

Cu nginx, transmiteți antetele `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` și cele pentru WebSocket (`Upgrade`, `Connection`). Fără antetul `Host` original, serverul respinge din motive de securitate cererile dispeceratului.

Apoi porniți aplicația cu Docker. Baza de date stă pe volumul `taxi-data`, deci rămâne și la actualizarea aplicației:

```bash
docker build -t taxi-hyp .
```

```bash
docker run -d --restart unless-stopped -p 3000:3000 -e ADMIN_PASSWORD='o-parola-lunga' -e TRUST_PROXY=1 -v taxi-data:/app/data taxi-hyp
```

**Pentru un test rapid**, fără server, un tunel temporar oferă o adresă HTTPS către calculatorul dvs.:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

**Important pentru șoferii care folosesc pagina web** (nu aplicația Android): pagina trebuie să rămână deschisă pe ecran în timpul turei. Browserele de pe telefon opresc GPS-ul când pagina trece în fundal sau ecranul se stinge (pagina cere ca ecranul să rămână aprins acolo unde browserul permite). Cum GPS-ul e obligatoriu, șoferul apare atunci „Fără GPS” și nu primește comenzi. Aplicația Android nu are această limitare.

## Cum funcționează

```
 Telefon șofer ──GPS──▶  Server Node.js  ──live──▶  Hartă (dispeceri autentificați)
   /driver       ◀─curse─  (Socket.IO)    ──live──▶  Client /track/<cod> (doar mașina lui)
                              │
                         data/taxi.db  ◀── Istoric, Flotă, Utilizatori, Jurnal (API REST)
```

- **Server**: Express + Socket.IO ([`src/app.js`](src/app.js)), API-ul REST în [`src/api.js`](src/api.js), API-ul aplicației șoferului în [`src/driver-api.js`](src/driver-api.js). Logica flotei și a curselor e în [`src/store.js`](src/store.js), conturile în [`src/accounts.js`](src/accounts.js), jurnalul în [`src/audit.js`](src/audit.js), iar baza de date în [`src/db.js`](src/db.js).
- **Hărți**: [Leaflet](https://leafletjs.com) cu hărți [OpenStreetMap](https://www.openstreetmap.org), fără cheie API. Căutarea adreselor folosește [Nominatim](https://nominatim.org).
- **Securitate**:
  - Parolele dispecerilor și PIN-urile șoferilor se păstrează doar ca hash scrypt.
  - Sesiunea dispecerului este un cookie `HttpOnly` și `SameSite=Strict`, pe care JavaScript-ul paginii nu îl poate citi. Cererile care modifică date și conexiunile live sunt acceptate doar din paginile aplicației.
  - Încercările greșite repetate (parole, PIN-uri) sunt blocate temporar.
  - Linkul clientului conține un cod aleatoriu de 128 de biți și arată doar mașina cursei respective, fără datele altor clienți. Linkul funcționează doar de la acceptarea comenzii până la încheierea cursei.
  - Șoferii văd numele și telefonul clientului doar după ce acceptă comanda.
- **Kilometrajul** se calculează doar cu clientul în mașină. Pozițiile GPS imprecise și salturile imposibile sunt ignorate.
- **Statusurile cursei**: `Se caută șofer` → `Mașină în drum` (acceptată, SMS trimis) → `Mașina a sosit` → `În cursă` → `Finalizată` (sau `Anulată` de dispecerat).

## Teste

```bash
npm test
```

Testele verifică:

- logica flotei și a curselor, baza de date (inclusiv repornirea serverului în timpul unei curse), istoricul și statisticile;
- comenzile: trimiterea la mașinile libere / cele mai apropiate, primul care acceptă câștigă, refuzul, expirarea, retrimiterea, anularea, linkul valabil doar cât durează cursa;
- GPS-ul obligatoriu: fără poziții recente (sau cu GPS-ul oprit de șofer) mașina nu primește și nu poate accepta comenzi, iar o poziție veche retrimisă nu contează;
- SMS-ul: formatul numerelor, textul de maxim 160 de caractere, cererile către SMSGate și Twilio, erorile furnizorului;
- asistentul vocal: extragerea adresei, numelui, telefonului și a detaliilor din convorbiri tipice de dispecerat;
- conturile: autentificare, expirarea sesiunilor, parole temporare, roluri, protecția ultimului administrator;
- un flux complet prin WebSocket și API (comandă → acceptare → SMS → link → finalizare), inclusiv doi șoferi care acceptă simultan: drepturi pe roluri, cereri respinse de pe alte site-uri, deconectarea la dezactivare și la ieșire, conținutul jurnalului;
- API-ul aplicației șoferului: sesiuni cu token, poziția prin HTTP, comenzile și cursa (și anularea ei) în răspuns, acceptarea prin HTTP, mașina „conectată” fără WebSocket.

GitHub Actions rulează testele și construiește APK-ul la fiecare modificare ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Limitări actuale și pași următori

- **Autentificare în doi pași (2FA)** pentru administratori nu există încă.
- **Un singur server.** SQLite e potrivit pentru o firmă cu zeci de mașini pe un server. Pentru mai multe servere în paralel ar fi nevoie de PostgreSQL și de un adaptor Socket.IO (ex. Redis).
- **iPhone:** aplicația există doar pentru Android. Pentru iOS e nevoie de un Mac cu Xcode și de un cont Apple Developer: `npx cap add ios` în `mobile/`, plus cheile de localizare în fundal din `Info.plist` (vezi documentația pluginului `@capacitor-community/background-geolocation`). Până atunci, pe iPhone se folosește pagina `/driver`.
- **Fără notificări push:** comenzile noi ajung în aplicație odată cu trimiterea poziției, deci doar cât timp tura e activă. Pentru anunțuri și cu tura oprită ar fi nevoie de Firebase Cloud Messaging.
- **Hărțile OpenStreetMap în aplicație:** serverele gratuite de hărți pot limita cererile venite din aplicații. Harta e secundară pentru șofer (navigarea se face cu Google Maps / Waze); la nevoie folosiți un furnizor de hărți propriu.
- **Starea de livrare a SMS-ului:** „trimis” înseamnă că furnizorul a preluat mesajul. Confirmarea de livrare la telefonul clientului (prin webhook) nu este încă urmărită.
- **Asistentul vocal** ascultă doar microfonul calculatorului. Pentru vocea clientului și numărul lui (afișarea automată a clientului care sună, cu adresele anterioare) ar fi nevoie de integrarea cu o centrală telefonică VoIP.
- **Timpul estimat** (în SMS, la șofer și în linkul clientului) se calculează din distanța în linie dreaptă, cu un factor pentru străzi. Pentru precizie mai mare se poate folosi un serviciu de rutare (OSRM, Google, Mapbox).
- **Serviciile OpenStreetMap gratuite** (hărți, Nominatim, rutarea din simulator) au limite de utilizare echitabilă. La trafic mare folosiți un furnizor comercial sau propriul server de hărți.
