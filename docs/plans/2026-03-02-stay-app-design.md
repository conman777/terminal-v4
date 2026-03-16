# Stay — Mental Health Support Social Platform

**Date:** 2026-03-02
**Status:** Design approved, ready for implementation planning

---

## Overview

A social platform like X.com, built specifically for people struggling with mental health — a place to post notes, find community, and feel supported. People who want to leave the world can read posts from others and find reasons to stay.

---

## Stack

- **Framework:** Next.js 14 (App Router) + TypeScript
- **Database:** PostgreSQL (Vercel Postgres) + Prisma ORM
- **Auth:** NextAuth.js (email + password, no OAuth in MVP)
- **Image storage:** Vercel Blob
- **Styling:** Tailwind CSS
- **Deployment:** Vercel

---

## Access Model

- Account required to both post **and** read
- Email + password signup

---

## Core Pages

| Page | Description |
|------|-------------|
| `/` | Landing + login/signup for logged-out users |
| `/feed` | Home feed — posts from followed users |
| `/explore` | All posts, discover new people |
| `/post/[id]` | Single post with comments |
| `/profile/[username]` | User profile, their posts |
| `/notifications` | Likes, comments, new followers |

---

## Data Model

### User
- id, username, email, passwordHash, avatar, bio, createdAt, isAdmin

### Post
- id, content (max 500 chars), imageUrl?, authorId, createdAt

### Comment
- id, content, postId, authorId, createdAt

### Like
- id, userId, postId (unique together)

### Follow
- id, followerId, followingId (unique together)

### Flag
- id, userId, postId, createdAt

### Notification
- id, userId, type (like/comment/follow), referenceId, read, createdAt

---

## Features

### Posts
- Text only or text + one image
- 500 character limit
- Like (heart), comment, flag buttons

### Feed
- Chronological (no algorithm in MVP)
- Shows posts from followed users
- Explore tab shows all posts

### Profiles
- Username, avatar, bio
- Follow/unfollow
- Tabs: their posts / liked posts

### Moderation
- Any user can flag a post
- Posts with 3+ flags auto-hidden pending admin review
- Admin account can view and delete flagged posts

### Notifications
- Someone liked your post
- Someone commented on your post
- Someone followed you

---

## UI Design

- Calm, warm aesthetic — soft colors, welcoming feel
- Mobile-first, fully responsive
- Dark mode support

---

## Out of Scope (MVP)

- Crisis hotline banners / safety features (add in v2)
- OAuth / social login
- Direct messages
- Algorithmic feed
- Post editing
- Hashtags / search
