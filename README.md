# Gmail Cleaner

A small browser-only web app for bulk-removing old Gmail messages. You pick a date range and any other filters, preview exactly what matches, then move it to Trash or, if you opt in, permanently delete it.

There is no backend. The app runs entirely in your browser tab: it signs in with Google Identity Services and calls the Gmail REST API directly. Access tokens live only in page memory and are never stored or sent anywhere else.

## 1. Google Cloud setup (one time, done by the owner)

You need your own OAuth client. It stays in **testing mode**, so only the Google accounts you list as test users can sign in.

1. **Create a project.** Open the [Google Cloud console](https://console.cloud.google.com/), use the project picker, and choose **New project**. Any name works, for example `gmail-cleaner`.
2. **Enable the Gmail API.** With the project selected, go to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
3. **Configure the OAuth consent screen.** Go to **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding / Audience**).
   - User type / audience: **External**.
   - App name, user support email, and developer contact email: fill in your own.
   - Scopes: you can leave this empty. The app requests its scopes at sign-in. For reference, they are `https://www.googleapis.com/auth/gmail.modify`, plus `https://mail.google.com/` only for permanent delete.
   - Leave the publishing status as **Testing**. Do not publish the app and do not submit it for verification.
4. **Add test users.** Under **Test users** (or **Audience → Test users**), add the Gmail address of each person who will use the app, yourself included. Nobody else can sign in. Google limits a testing-mode app to 100 test users.
5. **Create the OAuth client.** Go to **APIs & Services → Credentials → Create credentials → OAuth client ID** (or **Google Auth Platform → Clients → Create client**).
   - Application type: **Web application**.
   - Authorized JavaScript origins: add `http://localhost:5173`.
   - Authorized redirect URIs: leave empty. The popup token flow does not use one.
   - Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You do not need the client secret.
6. **Put the client ID in `.env`.**

   ```sh
   cp .env.example .env
   # edit .env and set:
   # VITE_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
   ```

   `.env` is gitignored. Never commit it.

> In testing mode, Google shows an "app hasn't been verified" warning at sign-in. That is expected for your own private client. Choose **Continue**. Testing-mode grants also expire after about 7 days, so you will occasionally see the consent screen again.

## 2. Run it

Requires Node.js 20.19+ (or 22.12+).

```sh
npm install
npm run dev
```

Open <http://localhost:5173>. The port is fixed at 5173 because it must match the authorized JavaScript origin. If something else is using that port, stop it rather than letting the app move to another port.

Other scripts:

| Command             | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm test`          | Unit tests (query builder, batching and backoff)     |
| `npm run typecheck` | TypeScript check                                     |
| `npm run build`     | Type check and production build into `dist/`         |

The tests use a mocked `fetch` and never contact Google.

## 3. Using it

1. **Sign in with Google** and allow Gmail access. The app asks only for `gmail.modify`, which lets it read, label, and trash mail but not permanently delete it.
2. **Set filters.** Only the date range is required, and only one end of it:
   - **Received from (inclusive)** / **Received to (inclusive)**: both days are included in full, in *your* time zone. Leave either blank for an open-ended range, but not both, so a run can never match the whole mailbox by leaving the date out. A From date after the To date is rejected and Preview stays disabled until it is fixed. The query uses absolute timestamps, `after:<epoch seconds>` (one second before midnight at the start of the From day) and `before:<epoch seconds>` (midnight at the start of the day after the To day), because Gmail interprets `after:YYYY/MM/DD` and `before:YYYY/MM/DD` in US Pacific time.
   - **From / To**: a name or address. Separate several with commas to match any of them.
   - **Subject contains**, **Has the words**, **Doesn't have**: literal text. Put `"quotes"` around a phrase in the word fields. Characters Gmail would treat as search syntax are quoted, and double quotes inside a term are dropped because Gmail cannot escape them.
   - **Label**: one of your labels, Inbox, or Sent. It is applied both as `label:` in the query and by label ID, so it matches that exact label only.
   - **Category**: Primary, Promotions, Social, Updates, or Forums.
   - **Read status**, **Has attachment**, **Larger than / Smaller than** (KB or MB).
   - **Extra Gmail search syntax**: anything else, using [Gmail search operators](https://support.google.com/mail/answer/7190). It is ANDed onto the query inside parentheses, ahead of the starred/important protections. Its quotes, parentheses and braces must be balanced, so it cannot close that group and widen the rest of the query; unbalanced input is rejected and Preview stays disabled.

   The exact Gmail query is shown as you type.
3. **Preview matches.** The app pages through every match to get an exact count (Gmail's own estimate is unreliable), then shows the newest 25 with date, sender, and subject. Changing any filter discards the preview.
4. **Confirm.** The dialog states the exact number of messages and the action. Only the previewed messages are acted on. Mail that arrives after the preview is not touched.
5. **Watch progress.** Messages are processed in batches of 500. Rate-limit responses (429, or a 403 with a rate-limit reason) and transient server errors are retried with exponential backoff. **Cancel** stops after the batch currently in flight.
6. **Summary.** Shows how many messages were processed, how many failed, and how many were not attempted (after a cancel or an expired sign-in).

**Sign out** revokes the access token with Google and clears everything from the page.

## Safety behaviour

- **Trash by default.** The default action moves mail to Gmail's Trash, where it can be restored for 30 days.
- **Protections on by default.** Starred mail (`-is:starred`) and mail Gmail marks important (`-is:important`) are excluded unless you untick those boxes. The page warns you when a protection is off.
- **Spam and Trash are never searched**, and nothing happens without a preview and an explicit confirmation of the exact count.
- **Ranges that reach today warn you** (a To date of today or later, or no To date) that recent mail will match too.
- **Permanent delete is opt-in and needs an extra step:**
  1. Choose **Permanently delete (cannot be undone)**.
  2. Grant the extra `https://mail.google.com/` permission when asked. This is the only scope that allows `messages.batchDelete`, so it is requested only at this point and never at sign-in. It must be granted for the account you are signed in with; if you pick a different Google account in the popup, that grant is revoked and nothing changes. Granting it discards any preview, so preview again afterwards.
  3. In the confirmation dialog, which warns that this cannot be undone, type `DELETE`.

  Permanently deleted mail skips Trash and cannot be recovered.
- **No background or scheduled deletion.** Nothing runs unless you click through the flow in an open tab.

## Project layout

```
src/lib/query.ts       filter form → Gmail search query (date/time-zone handling, quoting)
src/lib/gmail.ts       Gmail REST client, retry/backoff, batch runner
src/lib/auth.ts        Google Identity Services token client (sign-in, extra scope, revoke)
src/App.tsx            sign-in → filters → preview → confirm → progress → summary
src/components/        filter form and confirm dialog
```
