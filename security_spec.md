# Librarium Firestore Security Specification

## 1. Data Invariants
1. All user data resides strictly under `/users/{userId}` and is readable/writable ONLY when `request.auth != null`, `request.auth.token.email_verified == true` (for writes/reads of private library data), and `request.auth.uid == userId`.
2. Every document ID (`userId`, `bookId`, `noteId`, `entryId`, `quoteId`, `characterId`, `relationId`, `analysisId`, `convId`, `mediaId`) must match `^[a-zA-Z0-9_\-]+$` and be at most 128 characters.
3. Every subcollection document must include `userId == request.auth.uid` (and `userId == userId` path variable), immutable `id`, `userId`, and `createdAt`.
4. `notes`, `entries`, `quotes`, `characters`, `characterRelations`, `analyses`, and `conversations` must reference an existing parent book under `/users/{userId}/books/{bookId}` on `create`, and `bookId` is immutable on `update`.
5. `createdAt` must equal `request.time` on `create`, and `updatedAt` must equal `request.time` on both `create` and `update` (except `media` which is immutable after creation).
6. Array fields are strictly bounded: `book.tags.size() <= 10`, `quote.photoMediaIds.size() <= 5`, `analysis.themes.size() <= 12`, `analysis.connections.size() <= 20`, `analysis.questions.size() <= 10`, `conversation.history.size() <= 40`, `character.aliases.size() <= 20`, `character.traits.size() <= 30`, `character.evidence.size() <= 30`.
7. Media payloads (`media.dataUrl`) are bounded to `750000` characters to stay safely below the 1MB Firestore document limit.
8. Strict key allowlisting via `keys().hasAll(...) && keys().hasOnly(...)` on `create` and `diff().affectedKeys().hasOnly(...)` on `update` prevents shadow fields.
9. Community reports & feature suggestions reside under `/feedback/{feedbackId}`: any verified signed-in user (`request.auth.token.email_verified == true`) can `create` a report with `userId == request.auth.uid`, initial `status == 'open'`, empty `adminNote == ''`, and `createdAt == request.time`; users may read (`get`/`list`) only their own reports (`resource.data.userId == request.auth.uid`). Only the verified admin (`[redacted]`) can read all reports, update `status`/`adminNote`, or delete reports.
10. `/users/{userId}` stores account login metadata (`displayName`, `email`, `createdAt`, `lastActiveAt`, `visitCount`, `visitDays`) and a strictly non-private bounded reading summary (`booksCount`, `bookSummaries` <= 100 items with title/status/pages/percent only — zero comments, notes, quotes, reviews, or media). `visitCount` is a bounded integer (`1..1000000`, `1` on create, monotonically `existing` or `existing + 1` on update) and `visitDays` is bounded to `<= 30` date strings. Only the owner or verified admin (`isAdmin()`) may `get` a `/users/{userId}` document, and only `isAdmin()` may `list /users`. Private subcollections (`/books`, `/notes`, `/entries`, `/quotes`, `/characters`, `/characterRelations`, `/analyses`, `/conversations`, `/media`) remain strictly owner-only.
11. `/site_stats/{dateId}` stores admin-archived daily anonymous visit aggregates (`date`, `anonBoots` map <= 100 entries, `anonTotal`). Only the verified admin (`isAdmin()`) may read, list, create, update, or delete `/site_stats/{dateId}`.
12a. `characterRelations` additionally require `fromId != toId` and that both endpoints exist under the same user as `characters` of the same `bookId` on `create`; `bookId`, `fromId`, `toId` and `type` are immutable on `update` (only `description`, `evidence` and `certainty` can change). The relation ID is derived client-side from the book, type and endpoints, so equivalent relations always map to the same document. Character `certainty` is a map limited to the keys `age`, `description`, `occupation`, `affiliation` with values `explicit` or `inferred` (an absent key means unknown).

## 2. The "Dirty Dozen" Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read/write**: `GET /users/alice/books/b1` or `CREATE /feedback/f1` with `auth = null`.
2. **Cross-user access**: `GET /users/alice/books/b1`, `GET /users/alice`, `LIST /users`, or `GET /feedback/f_alice` with `auth = { uid: "bob", token: { email_verified: true } }`.
3. **Unverified email write**: `CREATE /users/alice/books/b1` or `CREATE /feedback/f1` with `auth = { uid: "alice", token: { email_verified: false } }`.
4. **Identity spoofing**: `CREATE /users/alice/books/b1` or `CREATE /feedback/f1` with `userId: "bob"` while signed in as `alice`.
5. **Shadow / Ghost field**: `CREATE /users/alice/books/b1` with extra field `isAdmin: true`.
6. **ID Poisoning**: `CREATE /users/alice/books/bad:id/extra` or 200-char ID.
7. **Orphaned sub-record**: `CREATE /users/alice/quotes/q1` referencing non-existent `bookId: "missing_book"`.
8. **Client timestamp forgery**: `CREATE /users/alice/books/b1`, `UPDATE /users/alice` (`lastActiveAt`), or `CREATE /feedback/f1` with forged timestamp instead of `request.time`.
9. **Immutable field tampering**: `UPDATE /users/alice/books/b1` attempting to modify `createdAt` or `userId`, or non-admin `UPDATE /feedback/f1` attempting to forge `status: "resolved"`.
10. **Unbounded array / DoW**: `CREATE /users/alice/books/b1` with 15 `tags`, `quotes/q1` with 6 `photoMediaIds`, or `users/alice` with 101 `bookSummaries`.
11. **Oversized string / DoW**: `CREATE /users/alice/media/m1` with `dataUrl` exceeding 750,000 bytes, or `feedback.message` > 2000 chars.
12. **Invalid rating / status / counter value**: `UPDATE /users/alice/books/b1` with `rating: 99` or `status: "hacked"`, or `UPDATE /users/alice` jumping `visitCount` by `+100` or negative value.


