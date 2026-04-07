# 🐴 Domarverktyg – Hoppallsvenskan Div 3

Interaktivt domarverktyg för laghoppning med procent-tillämpning.
Fungerar på mobil och dator.

## Funktioner

- **Importera Equipe-startlistor** (PDF) — grupperar ryttare per klubb automatiskt
- **Deltävling → Final** — komplett tävlingsflöde med kvalificering (minst 3 felfria)
- **Procent-tillämpning** — beräknar andel felfria ryttare, högst procent vinner
- **Mobilanpassad** — funkar i telefonen på tävlingsplatsen

## Kom igång

### 1. Installera
```bash
npm install
```

### 2. Kör lokalt
```bash
npm run dev
```
Öppna http://localhost:5173 i webbläsaren.

### 3. Publicera på nätet (gratis via Vercel)

1. Skapa ett konto på [vercel.com](https://vercel.com)
2. Skapa ett repo på [github.com](https://github.com) och pusha koden:
   ```bash
   git init
   git add .
   git commit -m "Domarverktyg"
   git branch -M main
   git remote add origin https://github.com/DITT-ANVÄNDARNAMN/domarverktyg.git
   git push -u origin main
   ```
3. På Vercel: klicka **"Add New Project"** → välj ditt repo → klicka **Deploy**
4. Klart! Du får en länk typ `domarverktyg.vercel.app` som alla kan öppna

## Tävlingsflöde

```
Förberedelse → Deltävling → Kvalresultat → Final → Slutresultat
```

1. **Förberedelse** — Importera startlista eller lägg till lag manuellt
2. **Deltävling** — Markera felfri/fel per ryttare
3. **Kvalresultat** — Lag med 3+ felfria går vidare
4. **Final** — Kvalificerade lag rider igen (nollställda resultat)
5. **Slutresultat** — Rangordning med procent, högst vinner 🏆
