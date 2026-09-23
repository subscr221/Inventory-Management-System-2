# Pilot User Briefing, CMF-ALIGARH

Status: DRAFT 2026-09-23 for the program director to check before it is handed out. Items marked
[fill in] need a name or phone number only the program director has.

This briefing is for the five people named in Table 1 of the pilot cutover runbook. Each person
gets one page. Read your own page; the last page is the same for everyone.

## Before you start: what the pilot is

The pilot is a practice run on a test copy of the system. Every item, stock figure and order in
it is made up (codes start with `MK-`). Nothing you do in the pilot touches the real ERP, real
stock or real money, and everything is deleted when the pilot ends. So try things, and tell us
what confuses you.

The people and their pilot accounts are listed in Table B1.

Table B1: Pilot people and accounts

| Role in the pilot | Person | Sign-in email |
| --- | --- | --- |
| Migration lead | Gagan Kumar | `info@ancorlabs.org` |
| Department head | [fill in name] | `subscr@ancorlabs.org` |
| Finance controller | [fill in name] | `accounts@ancorlabs.org` |
| CFO | Anupam | `anupam@ancorlabs.org` |
| Site head (runs the ERP) | [fill in name] | `cmf_supervisor@ancorlabs.org` |

## How to sign in (everyone)

1. Open [ims-staging.ancorlabs.org](https://ims-staging.ancorlabs.org) in Chrome or Edge, on a
   computer or a tablet.
2. The page sends you to a sign-in box. Type your email from Table B1 and the pilot password
   `1234`.
3. If the system asks you to set a new password, type `1234` again. This password is for the
   pilot only. Never use it anywhere else, and never use your real passwords here.
4. You land on the Frontline screen with your name at the top. The small badge shows
   "Online", "Pending sync" or "Needs attention".
5. To finish, press Sign out. On a shared tablet always sign out.

If the sign-in box says "Account is not fully set up", call the program director.

## Page 1: Migration lead (Gagan Kumar)

What you are for: you loaded the practice stock and you own the pilot's issue list.

A normal day:

1. Sign in once in the morning. Check the badge says "Online" and "Pending sync" shows 0.
2. On the Frontline screen, raise one purchase requisition for a pilot item (any `MK-` code),
   so we know requisitions still go through each day.
3. Write down anything that looked wrong, slow or confusing: screen, time, what you pressed.
   Send the list to the program director at the end of the day.
4. If a colleague says the system refused something, ask them for the error code on the card
   and add it to the list.

Only you: you are the only migration lead. Do not load stock files or documents during the
pilot unless the program director asks. A new load resets the sign-offs and the site has to be
signed off again.

## Page 2: Department head

What you are for: you decide what happens to work the system refused.

A normal day:

1. Sign in and open Refused captures from the top menu. Each card is one entry the server
   would not accept, with who, when, which device and why.
2. For each open card, talk to the person who made it, then press Resolve, write a short note
   (what was wrong, what was done instead) and press Confirm resolve.
3. Try the Frontline screens your job needs (fault report, work order status, meter reading).
4. Send the program director any card you could not explain.

Only you: you are the approver for refused captures. You cannot approve a card you made
yourself; the system refuses that on purpose.

## Page 3: Finance controller

What you are for: you are the money check. You approve stock differences and you hold the
approval rules.

A normal day:

1. Sign in and check Refused captures for anything that touches stock or cost.
2. When the program director tells you a stock difference is waiting, look at the explanation
   and approve it or send it back. [fill in: how the approval reaches you during the pilot]
3. Note any stock value that looks wrong and send it to the program director.

Only you: you are the only person who can change approval rules (who approves what). Do not
change them during the pilot. You cannot also be the CFO or the department head; the system
refuses that.

## Page 4: CFO (Anupam)

What you are for: you approve job-work offcuts kept as company stock.

A normal day:

1. Sign in once, check the badge, sign out. Most days need nothing more from you.
2. When the program director says an offcut approval is waiting, review and approve it.
   [fill in: how the approval reaches you during the pilot]

Only you: offcut acquisitions. You cannot also be the finance controller; the system checks
that two different people hold those jobs.

## Page 5: Site head

What you are for: you run the shop floor and the ERP, and you own the ERP feed account
(`erp1@ancorlabs.org`). Nobody else signs in as that account.

A normal day:

1. Sign in and walk the Frontline screens with the floor team: fault reports, work order
   status, spare issue, purchase requisition.
2. Make sure nobody types pilot entries into the real ERP. The pilot has its own made-up data.
3. At the end of the day tell the program director anything the floor team could not do.

Only you: the ERP feed account, and the decision to stop floor movements when the real
cutover comes (not during the pilot).

## Page 6: Forbidden during the pilot, and who to call (everyone)

Table B2 lists what nobody does during the pilot week, and why.

Table B2: Forbidden during the pilot

| Do not | Why |
| --- | --- |
| Enter real company data, or copy pilot entries into the real ERP | The pilot is made-up data and is deleted afterwards |
| Sign in as somebody else, or let somebody use your account | Every action is recorded against a named person; approvals check who you are |
| Record a calibration certificate | A wrong date locks the instrument and only a database restore undoes it |
| Change the minimum or maximum level of a critical spare | It cannot be corrected yet; a wrong level gives wrong alerts |
| Pick more than one lot holds in a single pick line | The system refuses it; split the pick, one line per lot |
| Pack an item you did not pick, or pack the wrong lot | Packing has no undo yet; the system refuses a wrong lot, report it |
| Trust the numbers on Dashboard, Reports or Workflows | Those screens show sample data, not the pilot's stock |
| Use the pilot password `1234` anywhere else | It is shared and public |

When something goes wrong, use Table B3.

Table B3: Who to call

| Problem | Call | How |
| --- | --- | --- |
| Cannot sign in, page will not load, "Needs attention" will not clear | Program director | [fill in phone] |
| A refused capture you do not understand | Department head | [fill in phone] |
| A stock figure or value looks wrong | Finance controller | [fill in phone] |
| Floor question: where is it, who moved it | Site head | [fill in phone] |
| Anything else, or nobody answers | Program director | [fill in phone] |

When you call, have ready: your email, the screen, the time, and the error code if a card shows
one.
