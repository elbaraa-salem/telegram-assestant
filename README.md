# Telegram Teaching Assistant
## Student, Lesson, and Payment Management for Independent Tutors

**Project type:** Applied software engineering / educational administration  
**Primary technologies:** TypeScript, Node.js, Express, SQLite, Telegram, and Google Calendar

> A teaching administration system that connects lesson schedules, student communication, and payment records. It brings together tools a tutor already uses and adds a structured record of what was scheduled, confirmed, completed, cancelled, and paid.

## 1. Project Overview

Telegram Teaching Assistant addresses the administrative work behind individual tutoring. A teacher may arrange lessons in Google Calendar, communicate with students through Telegram, and receive payment receipts in the same conversations. These activities are connected in practice, but their records are scattered across different applications.

The project provides a common workflow around those activities. Calendar events become local lesson records; reminders prompt students to confirm attendance; completed lessons create charges; and recorded payments settle outstanding charges or remain available as prepaid credit. A web interface allows the teacher to review and manage the resulting information.

The project grew out of the practical context of teaching Arabic to Russian-speaking students. Student records support Arabic and Russian names, and the implemented student-facing messages are primarily in Russian. Its central contribution is the integration of scheduling, communication, and financial tracking into a coherent application.

This document explains the implemented workflows and engineering decisions for readers who do not need to inspect the source code. It describes the supplied project version; it does not assert measured time savings, a particular user count, or independently verified service availability.

## 2. The Problem

Managing a lesson involves more than adding an appointment to a calendar. The teacher needs to know whether the student confirmed, whether a cancellation was recorded, whether the lesson actually took place, and how its cost relates to previous payments.

Manual tracking becomes particularly difficult when:

- A student pays for several future lessons at once.
- A payment covers only part of an outstanding lesson charge.
- The same receipt is sent again or processed through more than one message-handling path.
- An event is edited or removed from the calendar after related teaching or payment activity.
- A short student reply could refer to an old reminder instead of the next lesson.
- A network interruption causes messages to be delivered late or retrieved again.

The application represents these situations explicitly instead of relying on chat history as the only record.

## 3. Main Capabilities

| Capability | What it provides |
| --- | --- |
| Student administration | Student names, Telegram identity, calendar matching keyword, individual lesson price, currency, and active status |
| Calendar integration | Import and update relevant Google Calendar events as lesson records |
| Attendance reminders | Configurable upcoming-lesson reminders with confirmation and cancellation responses |
| Lesson tracking | Scheduled, confirmed, completed, and cancelled lesson states |
| Payment accounting | Outstanding charges, partial payments, payment allocation, and prepaid credit |
| Receipt handling | PDF receipt intake, payment information extraction, duplicate detection, and manual review paths |
| Teacher dashboard | Student management, lesson actions, calendar synchronization status, and financial information |
| Operational support | Background synchronization, message recovery paths, diagnostic logging, and receipt maintenance utilities |

## 4. How the System Works

### 4.1 Registering a student

The teacher creates a student record with a display name, Telegram details, a calendar keyword, and a lesson price. The keyword connects calendar event titles to the appropriate student. Telegram identity resolution supports linking a readable username to a stored account identifier.

The application also includes a welcome-message workflow that explains the interaction to the student. The teacher retains control over student details and whether the student is active.

### 4.2 Importing lesson schedules

The calendar integration reads events within a configurable time window and identifies relevant lessons using lesson markers and student keywords. Supported default markers include Arabic, Russian, and English terms.

Each imported event is associated with its Google Calendar event identifier. This gives the application a stable reference for subsequent updates and helps prevent repeated synchronization from creating duplicate lessons.

Synchronization includes protection for lessons that already have meaningful local activity. Completed, confirmed, or cancelled records require different handling from untouched scheduled events. Calendar deletion handling also distinguishes records that can be removed from those whose history must be retained.

Calendar access supports OAuth and service-account configuration. The integration requests read-only calendar access; lesson administration is maintained locally rather than presented as a two-way calendar editor.

### 4.3 Sending reminders and recording responses

The reminder service selects eligible upcoming lessons within a configurable look-ahead window, which defaults to 24 hours. This means a reminder is eligible within the next 24 hours, rather than promising delivery at exactly 24 hours before the lesson.

A reminder contains the lesson date and time and asks the student to confirm or request cancellation. It can also include an outstanding-payment reminder. Dates are formatted using a configurable application time zone.

The application stores reminder information and binds relevant replies to a pending lesson interaction. This matters because a message such as “1” or “yes” should not update an unrelated lesson. Ordinary messages outside an active interaction can be ignored without sending unnecessary automated replies.

### 4.4 Handling cancellations and completion

Cancellation information can include who cancelled, the reason, and relevant timestamps. The teacher can review and record cancellations through the web interface.

When a lesson is marked as completed, the application creates or retrieves the associated charge and updates the student's balance. Completion guards prevent already completed, cancelled, or calendar-deleted lessons from being processed as new completed lessons.

If prepaid credit covers the charge, the student can receive a remaining-balance message. Otherwise, the application can request a payment receipt and state the outstanding amount.

### 4.5 Recording and allocating payments

The financial model separates a payment from the lesson charge it settles. A payment may cover multiple charges; a charge may be settled through multiple payments. Allocation records connect the two.

The receipt workflow accepts PDF documents through Telegram, extracts receipt information, and records processing outcomes. The project includes a local text parser and routes for manual review or confirmation when a receipt cannot be safely applied. A receipt is evidence submitted to the application; this is not a direct bank-settlement integration.

After a confirmed payment is allocated to outstanding charges, unused value remains available as prepaid credit. The dashboard also supports manual financial entries for cases that need teacher intervention.

## 5. Payment Examples

The following are illustrative examples of the accounting model, not actual student records. Assume a lesson price of **1,000 RUB** and no other balance adjustments.

| Situation | Result |
| --- | --- |
| One unpaid lesson; payment of 300 RUB | 300 RUB is allocated and 700 RUB remains unpaid |
| A further payment of 700 RUB | The remaining charge is settled |
| One unpaid lesson; payment of 5,000 RUB | 1,000 RUB settles the debt and 4,000 RUB remains as credit |
| A later lesson is completed with that credit available | 1,000 RUB is applied, leaving 3,000 RUB in credit |
| An already recognized receipt is processed again | Duplicate handling prevents the same recognized payment from adding credit again |

The model tracks monetary amounts rather than relying only on an integer count of purchased lessons. This supports partial payments and allows the interface to derive an equivalent number of prepaid lessons from the student's configured price.

## 6. Architecture and Technology

The application uses a modular structure with a web interface, domain services, external integrations, and a shared relational database.

| Layer | Technology and responsibility |
| --- | --- |
| Application language | TypeScript provides types for records, service inputs, and workflow results |
| Runtime | Node.js runs the server and background processes |
| Web application | Express handles routes; EJS renders pages; Sass/CSS styles the interface |
| Persistence | SQLite, accessed through better-sqlite3, stores the application records |
| Messaging | GramJS connects to Telegram through an authenticated account session |
| Scheduling integration | Google APIs client reads calendar events |
| Document processing | pdf-parse extracts text from PDF receipts |
| Configuration | Environment variables control credentials, operating modes, time windows, and runtime behavior |

The Telegram integration uses an account session rather than a conventional Bot API command interface. This supports the project's existing tutor–student conversation workflow.

Services are separated by responsibility: calendar synchronization, reminders, Telegram message handling, lesson completion, payment allocation, student identity, welcome messages, and receipt processing. The calendar scheduler prevents overlapping runs within its process. The web application and message listener can operate as separate processes against the same database.

### Core data model

| Record | Purpose |
| --- | --- |
| Students | Identity, matching information, lesson price, and active status |
| Lessons | Schedule, attendance response, reminder information, completion, and cancellation history |
| Payments | Payment amount, currency, receipt information, and processing status |
| Lesson charges | Amount owed and the amount already paid against each charge |
| Payment allocations | The portion of a payment assigned to a particular charge |
| Telegram messages | Message identifiers, processing state, and related records |
| Application settings | Persistent operational settings and integration status |

The schema also includes lesson-package records. The payment-allocation model is particularly important because it expresses financial relationships that a simple paid/unpaid checkbox cannot represent.

## 7. Engineering Challenges Addressed

### Avoiding duplicate financial effects

Messages can arrive through live events and later be retrieved through polling. Students can also resend receipts. The implementation combines message-processing locks, stored message identifiers, database uniqueness constraints, and receipt fingerprints to recognize repeated work. Conflicting information is handled separately from a matching duplicate.

These mechanisms reduce the risk of crediting a recognized payment twice. They are implementation safeguards, not a claim that every possible duplicate receipt format can be detected.

### Keeping financial changes consistent

Database transactions group related operations, including lesson completion, charge creation, and payment allocation. The aim is to prevent partially applied financial changes from leaving the stored balance inconsistent.

### Preserving local teaching history

A calendar is a scheduling source, but it should not erase evidence of a completed lesson or payment allocation. Synchronization therefore considers local status and related records before changing or deleting lesson data.

### Handling asynchronous communication

The message listener includes live-event processing, optional polling, connection health checks, and recovery logic. Stored processing outcomes and duplicate checks help these paths cooperate. Reply binding and expiration checks address the separate problem of assigning a student's response to the correct lesson.

### Supporting review and maintenance

The system includes manual teacher actions, diagnostic information, test-data controls, dry-run modes for selected operations, and receipt cleanup utilities. These features make it possible to inspect and manage the workflow beyond its normal successful path.

## 8. Validation Included in the Project

The supplied source includes scenario-oriented test scripts for:

- Binding reminders and replies to the correct lesson.
- Ignoring messages when no relevant interaction is pending.
- Lesson cancellation workflows.
- Receipt parsing and recognition of unrelated documents.
- Receipt-processing idempotency and payment conflicts.
- Student welcome messages.
- Receipt cleanup behavior.
- Production configuration checks and payment notifications.

The package also defines TypeScript checking and production build commands. These provide a basis for reproducible verification of both application structure and important workflow scenarios.

**Verification scope:** this overview was prepared from source inspection. The listed tests are present in the supplied version; this document does not claim that they were executed during its preparation or that live integrations were tested.

## 9. Software Engineering Value

This project demonstrates the translation of a practical teaching problem into an integrated software system. Its engineering value lies in the relationships between workflows, especially where scheduling, communication, and payment records must agree.

The implementation provides concrete evidence of work in:

- **Requirements analysis:** identifying tutor-specific needs such as confirmation, cancellation, partial payment, and advance credit.
- **Relational data modelling:** representing students, lessons, charges, payments, and allocations as connected records.
- **Integration development:** coordinating an external calendar, a messaging platform, PDF documents, and a local application.
- **Backend design:** separating domain responsibilities and implementing guarded state changes.
- **Reliability engineering:** considering repeated events, interruptions, conflicting inputs, and record preservation.
- **Web development:** exposing practical administrative actions through a server-rendered interface.
- **Validation:** defining focused scenarios around failure-prone parts of the workflow.

For a software engineering portfolio, the project illustrates work beyond isolated programming exercises: a domain-specific application with persistent state, external dependencies, and business rules that must remain consistent over time.

## 10. Current Scope and Future Development

The supplied implementation is designed around a tutor's own administrative workflow. It should not be described as a fully evaluated, multi-institution learning management platform.

Useful future development includes stronger administrator access controls before public exposure, clearer operational monitoring, automated backup and restore verification, broader receipt-format tests, and a more complete multilingual interface. A multi-teacher edition would additionally require explicit account separation and access rules.

A formal evaluation could measure administrative time per lesson, reminder delivery success, payment-processing exceptions, and the rate of duplicate records under repeated-event tests. These are proposed evaluation measures, not results already established by the project.

## Portfolio Description

Developed a Telegram-integrated teaching administration application connecting Google Calendar schedules, student communication, and lesson-payment accounting. Implemented a TypeScript and Node.js backend, an Express-based administration interface, and a SQLite data model supporting lesson charges, partial payments, prepaid credit, and payment allocations. Addressed practical reliability challenges through duplicate receipt detection, guarded lesson-state changes, transactional financial updates, and scenario-based test scripts. The project applies software engineering to the everyday administrative needs of independent tutoring.
