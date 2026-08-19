# 🚀 EventFlow - Quick Start (15 Minutes)

## You now have the complete EventFlow folder!

This folder contains everything you need. Follow these steps to get it running.

---

## ✅ STEP 1: Prerequisites (Already Installed?)

Make sure you have:
- ✅ **Node.js 18+** → https://nodejs.org/
- ✅ **Docker Desktop** → https://www.docker.com/products/docker-desktop

Check by opening PowerShell and running:
```
node --version
docker --version
```

If both show versions, you're ready! ✓

---

## 📁 STEP 2: Place This Folder in the Right Location

**Where to put the `eventflow` folder:**

### Option 1: Downloads (Easiest)
1. Cut/Copy this `eventflow` folder
2. Paste it in `C:\Users\YourUsername\Downloads\`
3. Final path should be: `C:\Users\YourUsername\Downloads\eventflow\`

### Option 2: Desktop
1. Cut/Copy this `eventflow` folder
2. Paste it on your Desktop
3. Final path should be: `C:\Users\YourUsername\Desktop\eventflow\`

### Option 3: Documents
1. Cut/Copy this `eventflow` folder
2. Paste it in Documents
3. Final path should be: `C:\Users\YourUsername\Documents\eventflow\`

**Pick ONE location and remember it!** You'll need it in Step 3.

---

## 🖥️ STEP 3: Open PowerShell in the EventFlow Folder

### Easiest Method:
1. **Open File Explorer**
2. **Go to where you put the eventflow folder** (Downloads/Desktop/Documents)
3. **Open the `eventflow` folder**
4. **Right-click on empty space inside the folder**
5. **Look for "Open PowerShell here"** or **"Open in Terminal"**
6. **Click it**

PowerShell will open in the correct folder! ✓

### Alternative Method:
1. **Open PowerShell** (Windows key → type `powershell` → click it)
2. **Run this command** (change the path based on where you put it):
   ```
   cd C:\Users\YourUsername\Downloads\eventflow
   ```
   
   Or:
   ```
   cd C:\Users\YourUsername\Desktop\eventflow
   ```

---

## 🚀 STEP 4: Run Setup Commands (5 minutes)

In PowerShell (in your eventflow folder), run these commands **one by one**:

### Command 1:
```
docker-compose up -d
```
Wait for it to finish (1-2 minutes).

### Command 2:
```
cd backend
```

### Command 3:
```
npm install --legacy-peer-deps
```
Wait for it to finish (1-2 minutes).

### Command 4:
```
npm run migrate:latest
```
Wait for it to finish.

### Command 5:
```
cd ../frontend
```

### Command 6:
```
npm install --legacy-peer-deps
```
Wait for it to finish.

### Command 7:
```
cd ../admin
```

### Command 8:
```
npm install --legacy-peer-deps
```
Wait for it to finish.

---

## 🎉 STEP 5: Start the Services (3 minutes)

Once all 8 commands finish, you need to **open 4 new PowerShell windows**.

**In EACH window:**
1. Navigate to your eventflow folder (see Step 3)
2. Run ONE of these commands:

**PowerShell Window 1:**
```
cd backend
npm run dev
```

You should see: `[EventFlow-API] EventFlow API listening on http://localhost:3000`

---

**PowerShell Window 2:**
```
cd backend
npm run jobs:start
```

You should see: `[Job-Worker] Job worker started and jobs scheduled`

---

**PowerShell Window 3:**
```
cd frontend
npm run dev
```

You should see: `Local: http://localhost:5173/`

---

**PowerShell Window 4:**
```
cd admin
npm run dev
```

You should see: `Local: http://localhost:3001/`

---

## 🌐 STEP 6: Open Your Browser (2 minutes)

Once all 4 windows show "running", open these URLs:

### Main Event Search App:
```
http://localhost:5173
```
You should see the event search interface!

### Admin Dashboard:
```
http://localhost:3001
```
You should see the admin dashboard with metrics!

### Database Browser (Optional):
```
http://localhost:8080
```
Login with:
- User: `eventflow`
- Password: `eventflow`

---

## ✨ THAT'S IT! 🎉

You now have a fully working event aggregation platform!

### What you can do:
✅ Search for events
✅ View event details
✅ See real-time metrics in admin
✅ Browse the database
✅ Watch crawlers discovering events

---

## 🐛 If Something Goes Wrong

### Error: "docker is not recognized"
→ Docker is not installed. Go to https://www.docker.com/products/docker-desktop

### Error: "npm install fails"
→ Run: `npm install --legacy-peer-deps --no-save`

### Error: "Ports already in use"
→ Close other applications using those ports, or restart your computer

### Error: "no configuration file provided"
→ Make sure you're in the eventflow folder (see Step 3)

### Need more help?
→ Read `COMPLETE_STARTUP_GUIDE.md` - it has a full troubleshooting section

---

## 🎯 Summary

1. ✅ Have Node.js and Docker installed
2. ✅ Place eventflow folder in Downloads/Desktop/Documents
3. ✅ Open PowerShell in that folder
4. ✅ Run 8 setup commands (one by one)
5. ✅ Open 4 PowerShell windows with different commands
6. ✅ Open browsers to the 3 URLs
7. ✅ Enjoy your platform!

**Total time: ~15 minutes**

---

## 📚 For More Information

- **READ_THIS_FIRST.md** - Quick overview
- **COMPLETE_STARTUP_GUIDE.md** - Full detailed guide
- **WHAT_YOULL_SEE.md** - Visual preview
- **README.md** - Complete reference

---

## 🚀 You've Got This!

Everything is ready to go. Just follow these steps and you'll have a fully working event aggregation platform in 15 minutes!

**Good luck!** 💪
