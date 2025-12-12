#!/bin/bash

# Warna text
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo -e "${GREEN}[+] Memulai Instalasi WINTUNELING STORE BOT...${NC}"

# Update System & Install Git/Curl
echo -e "${GREEN}[+] Mengupdate sistem...${NC}"
sudo apt-get update
sudo apt-get install -y git curl unzip

# Install Node.js (Versi 18 LTS)
echo -e "${GREEN}[+] Menginstall Node.js...${NC}"
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

echo -e "${GREEN}[+] Mengunduh Script Bot...${NC}"
rm -rf bot-store
git clone https://github.com/windrase/bot-store.git bot-store

cd bot-store

# Install Dependencies
echo -e "${GREEN}[+] Menginstall Module (npm install)...${NC}"
npm install
npm install -g pm2

# Jalankan Setup
echo -e "${GREEN}[+] Menjalankan Setup Wizard...${NC}"
echo "------------------------------------------------"
node install.js

# Start Bot dengan PM2 (Agar jalan 24 jam)
echo -e "${GREEN}[+] Menjalankan Bot di Background...${NC}"
pm2 start index.js --name "bot-store"
pm2 save
pm2 startup

echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}   ✅ INSTALASI SELESAI! BOT BERJALAN    ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "Ketik 'pm2 log' untuk melihat aktivitas bot."
echo -e "Ketik 'pm2 stop bot-store' untuk mematikan."
