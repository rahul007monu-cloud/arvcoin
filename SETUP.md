# Firebase setup — step by step

Follow this once to connect arvcoin to a Firebase project. Everything is done
in the browser except the final rules deploy.

> **Status: steps 1–3 are done.** The project is created and connected:
>
> | | |
> |---|---|
> | Project ID | `arvcoin-fbd29` |
> | Project number | `44275546012` |
> | Auth domain | `arvcoin-fbd29.firebaseapp.com` |
>
> `firebase-config.js` is updated and `.firebaserc` pins the project, so
> `firebase deploy` no longer needs a `--project` flag.
>
> Users from the old inaccessible project do not carry over — they will need
> to sign up again.

---

## 1. Create the project

1. Open <https://console.firebase.google.com>
2. Confirm the account in the top-right avatar is the one you want to own this
3. Click **Create a project**
4. Name it `arvcoin` — note the **Project ID** it generates underneath
   (likely `arvcoin-app` or similar). **Write that ID down**, you need it later
5. Google Analytics is optional. Disabling it is fine
6. Click **Create project**

---

## 2. Register the web app

1. On the project overview, click the **web icon** `</>`
2. App nickname: `arvcoin web`
3. Leave "Firebase Hosting" **unchecked** — the site is hosted on Hostinger
4. Click **Register app**
5. You will see a `firebaseConfig` block. **Copy all of it.**

It looks like this:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "arvcoin-app.firebaseapp.com",
  projectId: "arvcoin-app",
  storageBucket: "arvcoin-app.firebasestorage.app",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123def456",
  measurementId: "G-XXXXXXXXXX"
};
```

---

## 3. Paste it into `firebase-config.js`

Open `firebase-config.js` in the repo and replace the values. Keep the
`window.ARV_FIREBASE_CONFIG =` wrapper exactly as it is:

```js
window.ARV_FIREBASE_CONFIG = {
  apiKey: "PASTE_YOURS",
  authDomain: "PASTE_YOURS",
  projectId: "PASTE_YOURS",
  storageBucket: "PASTE_YOURS",
  messagingSenderId: "PASTE_YOURS",
  appId: "PASTE_YOURS",
  measurementId: "PASTE_YOURS"
};
```

These values are **public by design** — they ship in the frontend of every
Firebase web app. They are not secrets.

---

## 4. Turn on Authentication

1. Left menu → **Build → Authentication** → **Get started**
2. **Sign-in method** tab → enable **Email/Password** → Save
3. Enable **Google** as well:
   - Pick a support email from the dropdown
   - Save
4. **Settings** tab → **Authorised domains** → **Add domain** → `arvcoin.com`

Without step 4, Google sign-in fails on the live site.

---

## 5. Create the Firestore database

1. Left menu → **Build → Firestore Database** → **Create database**
2. Choose **Start in production mode** — the repo ships proper rules, so an
   open test mode is unnecessary and unsafe
3. Location: **asia-south1 (Mumbai)** for the lowest latency in India.
   **This cannot be changed later.**
4. Click **Enable**

---

## 6. Deploy the security rules

This is the step that actually enforces access gating. Nothing works properly
without it.

```bash
npm install -g firebase-tools     # once
firebase login                    # opens a browser
firebase deploy --only firestore:rules,firestore:indexes
```

No `--project` flag needed — `.firebaserc` pins it to `arvcoin-fbd29`.

**No terminal available?** Paste the rules manually instead:

1. Firestore Database → **Rules** tab
2. Delete everything in the editor
3. Open `firestore.rules` from the repo, copy the whole file, paste it in
4. Click **Publish**

The indexes can be added later — Firestore will show a direct "create index"
link in the browser console the first time a query needs one.

---

## 7. Make yourself admin

1. Sign up on the live site with your email
2. Go to `arvcoin.com/dashboard.html` → **Settings** → copy your **UID**
3. Firebase Console → Firestore Database → **Start collection**
4. Collection ID: `admins`
5. Document ID: **paste your UID**
6. Add two fields:

   | Field | Type | Value |
   |---|---|---|
   | `admin` | boolean | `true` |
   | `analyst` | boolean | `true` |

7. Save
8. On the site: **sign out, then sign back in** — the role is read at sign-in

`arvcoin.com/admin.html` now opens.

---

## 8. Optional — email OTP

`emailjs-config.js` holds EmailJS keys for the one-time verification email. If
they are missing or invalid, signup still works and the OTP is printed to the
browser console in DEMO mode.

To set it up properly: sign up free at <https://www.emailjs.com>, create an
email service and a template containing `{{passcode}}` in the body and
`{{email}}` in the "To Email" field, then paste the three IDs into
`emailjs-config.js`.

---

## Checklist

- [x] Project created — `arvcoin-fbd29`
- [x] Web app registered, config copied
- [x] `firebase-config.js` updated
- [ ] Email/Password sign-in enabled
- [ ] Google sign-in enabled
- [ ] `arvcoin.com` added to authorised domains
- [ ] Firestore created in production mode, asia-south1
- [ ] `firestore.rules` deployed or pasted
- [ ] Signed up on the live site
- [ ] `admins/{your-uid}` document created with `admin: true` and `analyst: true`
- [ ] Signed out and back in
- [ ] `admin.html` opens

---

## Troubleshooting

**"Missing or insufficient permissions"**
The rules are not deployed. Redo step 6.

**Google sign-in opens then closes with an error**
`arvcoin.com` is missing from authorised domains. Step 4.

**`admin.html` redirects to the dashboard**
Either the `admins/{uid}` document is missing, the UID does not match exactly,
the fields are strings instead of booleans, or you have not signed out and
back in since creating it.

**Nothing loads and the console says `auth/invalid-api-key`**
`firebase-config.js` still has old or partial values. Step 3.

**Analysis or notes will not publish**
Check you are on `admin.html` as an analyst, and that the rules are deployed.
The browser console shows the exact rule that rejected the write.
