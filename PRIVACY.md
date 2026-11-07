# SubLingo — Privacy Policy

_Last updated: 2026-09-27_

SubLingo is a browser extension that helps you learn languages while
watching video: it translates on-screen subtitles, shows the meaning of
individual words on hover, and provides example sentences. This policy
explains exactly what data the extension handles.

## What SubLingo does NOT do

- It does **not** collect, store, or transmit any personally identifying
  information (no name, email, account details, or login credentials).
- It does **not** use analytics, tracking, advertising, or fingerprinting.
- It does **not** sell or share data with anyone for advertising.
- It does **not** create a profile of you or your viewing history.

## Data the extension sends to third parties

To translate text, SubLingo sends **subtitle text** — full subtitle lines
and individual words you hover or click — to **Google Translate**
(`translate.googleapis.com`). This is the extension's only translation
provider: no account, sign-up, or API key is ever required.

Only the subtitle text needed for translation is sent. This is done
transiently to perform the translation you requested; SubLingo does not
store these translations on any server. The handling of that text by
Google is governed by Google's own privacy policy.

## Vocabulary quiz

When you save a word (☆), SubLingo stores the word, the subtitle line it
appeared in, and its dictionary meanings **locally in your browser**
(extension storage). To look up those meanings it queries Google Translate
and Wiktionary (`en.wiktionary.org`) with the saved word.

When you answer a quiz question, your answer text is sent to Google
Translate to be translated into English, and is then compared with the
stored meanings by a small AI model that runs **entirely on your device**.
The model's weights (~23 MB) are downloaded once from Hugging Face
(`huggingface.co`) and cached; no quiz answers or saved words are ever sent
to Hugging Face or to the extension's developer.

## Data read from the pages you visit

On supported video sites (currently Crunchyroll and YouTube), the extension reads the
page's playback information locally in your browser to locate the correct
subtitle track. This information is processed on your device only and is
**not** sent anywhere except that the resulting subtitle text may be sent
for translation as described above.

## Data stored on your device

SubLingo stores your **settings** using the browser's extension storage:
your target language, dictionary language, and the enabled/disabled
toggle. This data stays in your browser (synced by your browser account
if you use browser sync) and is never sent to the extension's developer.

## Permissions

- **storage** — to save your settings.
- **host access** to Crunchyroll and YouTube (to read subtitle tracks),
  to Google Translate (to perform translations), to Wiktionary (word
  meanings for the quiz), and to Hugging Face (one-time download of the
  on-device quiz model). No other sites are accessed.

## Changes

If this policy changes, the updated version will be posted at this same
location with a new "Last updated" date.

## Contact

Questions about this policy: **samyhashem.study@gmail.com**
