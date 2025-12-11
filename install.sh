#!/bin/bash

# Warna text
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo -e "${GREEN}[+] Memulai Instalasi WINTUNELING STORE BOT...${NC}"

# 1. Update System & Install Git/Curl
echo -e "${GREEN}[+] Mengupdate sistem...${NC}"
sudo apt-get update
sudo apt-get install -y git curl unzip

# 2. Install Node.js (Versi 18 LTS)
echo -e "${GREEN}[+] Menginstall Node.js...${NC}"
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

echo -e "${GREEN}[+] Mengunduh Script Bot...${NC}"
rm -rf wintuneling-bot
git clone https://github.com/windrase/bot-store.git bot-store

cd bot-store

# 4. Install Dependencies
echo -e "${GREEN}[+] Menginstall Module (npm install)...${NC}"
npm install
npm install -g pm2

# 5. Jalankan Setup
echo -e "${GREEN}[+] Menjalankan Setup Wizard...${NC}"
echo "------------------------------------------------"
node install.js

# 6. Start Bot dengan PM2 (Agar jalan 24 jam)
echo -e "${GREEN}[+] Menjalankan Bot di Background...${NC}"
pm2 start index.js --name "bot-store"
pm2 save
pm2 startup

echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}   ✅ INSTALASI SELESAI! BOT BERJALAN    ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "Ketik 'pm2 log' untuk melihat aktivitas bot."
echo -e "Ketik 'pm2 stop bot-store' untuk mematikan."
