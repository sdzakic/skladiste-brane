# Skladište – evidencija ulaza i izlaza dijelova

**Aplikacija je objavljena na: https://sdzakic.github.io/skladiste-brane/**

Jednostavna aplikacija za telefon i računalo: baza dijelova sa slikama, ulaz i izlaz
po dokumentima, skeniranje šifre kamerom (barkod / OCR) i ispis dokumenta za potpis.

Radi **bez servera i bez AI API-ja**. Svi podaci su spremljeni u pregledniku uređaja,
OCR (prepoznavanje teksta) radi lokalno pomoću Tesseract.js biblioteke.

## Što aplikacija radi

**Artikli**
- Šifra, naziv, jedinica mjere, početno stanje, napomena, **slika dijela** (slikaj kamerom ili iz galerije).
- „Očitaj tekst sa slike“: OCR pročita natpis s etikete i jednim dodirom upiše šifru ili naziv.
- Dodir na artikl otvara **karticu**: trenutno stanje i sav promet (+ / −) po dokumentima.
- Ikona kamere uz pretragu: skeniraj barkod ili šifru i odmah otvori artikl.

**Ulaz / Izlaz**
- Datum, vrijeme, lokacija, osoba (tko predaje / preuzima), napomena.
- Stavke: šifra, naziv, količina. Ulaz zbraja (+), izlaz oduzima (−).
- Dodavanje stavki: tipkanjem (s prijedlozima), skeniranjem šifre kamerom, ili **OCR popisa**:
  slikaš papir / popis s više šifri i količina, aplikacija prepozna artikle iz baze i količine, ti samo potvrdiš.
- Kod izlaza upozorava ako je količina veća od stanja (može se svejedno spremiti).
- „Spremi i ispiši“ dodijeli broj dokumenta (`U-2026-0001` za ulaz, `I-2026-0001` za izlaz) i otvori
  **dokument za ispis** s tablicom stavki, napomenom i dva polja za potpis (Predao / Zaprimio, Izdao / Preuzeo).

**Dokumenti**
- Popis svih primki i izdatnica, filter po tipu, ponovno otvaranje i ispis, brisanje (vraća stanje).

**Postavke**
- Naziv tvrtke/skladišta i adresa za zaglavlje dokumenta, odgovorna osoba, zadana lokacija, OCR jezik.
- **Sigurnosna kopija** (JSON, uključuje slike) i učitavanje kopije na drugi uređaj.
- Izvoz stanja i prometa u CSV (otvara se u Excelu).

## Kako pokrenuti

### Na telefonu (preporučeno)
Aplikaciju treba staviti na bilo koji besplatni web hosting s HTTPS-om, npr.:

- **Netlify Drop** (najjednostavnije): otvori https://app.netlify.com/drop i povuci cijelu mapu projekta.
  Dobiješ adresu tipa `https://nesto.netlify.app`.
- **GitHub Pages**: učitaj datoteke u repozitorij i uključi Pages.

Zatim na telefonu otvori adresu i dodaj na početni zaslon:
- **Android (Chrome)**: izbornik ⋮ → „Dodaj na početni zaslon“ / „Instaliraj aplikaciju“.
- **iPhone (Safari)**: Dijeli ▢↑ → „Dodaj na početni zaslon“.

Nakon toga radi i bez interneta (osim prvog preuzimanja OCR jezika, vidi dolje).

### Na računalu (lokalno)
U mapi projekta pokreni:

```bash
python3 -m http.server 8765
```

i otvori http://localhost:8765 u pregledniku. Ispis dokumenta ide kroz Ctrl/Cmd+P → „Spremi kao PDF“ ili na pisač.

## Važno znati

- **Podaci su samo na uređaju** na kojem je aplikacija otvorena. Telefon i računalo nemaju zajedničku bazu.
  Redovito napravi *Sigurnosnu kopiju (JSON)* u Postavkama i prebaci je (npr. e-mailom) ako treba na drugi uređaj.
  Ne briši podatke preglednika za tu adresu.
- **OCR prvi put treba internet**: jezični paket (oko 10–15 MB) se preuzima jednom i sprema u preglednik.
  Poslije radi offline.
- **Barkod skeniranje uživo** (kamera bez slikanja) radi na Androidu u Chromeu. Na iPhoneu se barkod čita
  sa slike koju slikaš, a ako to ne uspije, slijedi OCR.
- Za bolji OCR: slikaj ravno, uz dobro svjetlo, tekst neka bude krupan u kadru. Aplikacija tolerira tipične
  OCR zamjene (O/0, I/1, S/5, B/8) pri traženju šifre.
- Na iPhoneu „Ispiši / PDF“ otvara sustavski dijalog za ispis; „Dijeli“ nudi spremanje kao PDF.

## Datoteke

| Datoteka | Sadržaj |
|---|---|
| `index.html` | struktura ekrana i dijaloga |
| `app.js` | logika: baza (IndexedDB), artikli, dokumenti, OCR, ispis, izvoz |
| `styles.css` | izgled, tamna tema, stil ispisa (A4) |
| `sw.js` | rad bez interneta (service worker) |
| `manifest.json`, `icon*.png`, `icon.svg` | instalacija na početni zaslon |
