# AGYASHtv IPTV Player

Cross-platform IPTV player for Android mobile, Android TV and PC. Sign in using your own authorized Xtream Codes-compatible provider details: Server / Portal URL, username and password.

Features include Live TV, Movies, Series, categories, search, favorites, episode selection and video playback. Remember-me credentials are stored on-device. Browser sessions are encrypted and stored in an HttpOnly cookie.

Deploy this repository to Vercel from its root. Set XTREAM_SESSION_SECRET to a random secret of at least 32 bytes for browser sessions. Each user enters their own provider URL; no global provider URL is required.

GitHub Actions builds Android mobile APK, Android TV APK, Windows installer and PC web ZIP. Only use provider accounts and content you are authorized to access.

Local build: npm install, npm run typecheck, npm run build:web.
