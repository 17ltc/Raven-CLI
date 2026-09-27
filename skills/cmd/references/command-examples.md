# Command Examples

This file contains common command examples that the agent can reference when suggesting shell commands to users.

## File Operations

### Basic Navigation
```bash
# List current directory
ls
dir (Windows)

# List with details
ls -la
dir /s (Windows)

# Change directory
cd /path/to/directory
cd C:\path\to\directory (Windows)

# Show current directory
pwd
cd (Windows)
```

### File Management
```bash
# Create directory
mkdir new_folder

# Remove empty directory
rmdir folder_name

# Copy file
cp source.txt destination.txt
copy source.txt destination.txt (Windows)

# Move/rename file
mv old.txt new.txt
move old.txt new.txt (Windows)

# View file contents
cat file.txt
type file.txt (Windows)

# Search in files
grep "pattern" file.txt
findstr "pattern" file.txt (Windows)
```

## System Information

### System Status
```bash
# Disk usage
df -h
wmic logicaldisk get size,freespace (Windows)

# Memory usage
free -h
wmic OS get TotalVisibleMemorySize,FreePhysicalMemory (Windows)

# CPU information
top
tasklist (Windows)

# System information
uname -a
systeminfo (Windows)
```

### Process Management
```bash
# List processes
ps aux
tasklist (Windows)

# Kill process
kill PID
taskkill /PID PID (Windows)

# Find process by name
pgrep process_name
tasklist | findstr process_name (Windows)
```

## Network Operations

### Connectivity
```bash
# Ping host
ping google.com

# Trace route
traceroute google.com
tracert google.com (Windows)

# DNS lookup
nslookup domain.com

# Show network config
ifconfig
ipconfig (Windows)

# Check open ports
netstat -an
```

### File Transfer
```bash
# Download file
curl -O https://example.com/file.txt
wget https://example.com/file.txt

# Upload file (with FTP)
ftp ftp.example.com

# SSH connection
ssh user@host
```

## Development Tools

### Git
```bash
# Initialize repository
git init

# Clone repository
git clone https://github.com/user/repo.git

# Check status
git status

# Add files
git add .
git add file.txt

# Commit changes
git commit -m "message"

# Push changes
git push origin main

# Pull changes
git pull origin main

# View log
git log
```

### Python
```bash
# Check version
python --version
python3 --version

# Run script
python script.py

# Install package
pip install package_name

# List installed packages
pip list

# Create virtual environment
python -m venv venv
python -m venv venv (Windows)

# Activate virtual environment
source venv/bin/activate
venv\Scripts\activate (Windows)
```

### Node.js
```bash
# Check version
node --version
npm --version

# Initialize project
npm init

# Install dependencies
npm install
npm install package_name

# Run script
npm run script_name
```

## Package Management

### Linux (apt)
```bash
# Update package list
sudo apt update

# Upgrade packages
sudo apt upgrade

# Install package
sudo apt install package_name

# Remove package
sudo apt remove package_name

# Search for package
apt search package_name
```

### Windows (chocolatey)
```bash
# Install package
choco install package_name

# Update package
choco upgrade package_name

# Remove package
choco uninstall package_name

# List packages
choco list
```

## Security Operations

### File Permissions
```bash
# Change permissions
chmod 755 file.txt

# Change owner
chown user:group file.txt

# View permissions
ls -la file.txt
```

### Encryption
```bash
# Encrypt file (GPG)
gpg --encrypt file.txt

# Decrypt file
gpg --decrypt file.txt

# Generate SSH key
ssh-keygen -t rsa -b 4096
```

## Text Processing

### Basic Text Operations
```bash
# Count lines
wc -l file.txt

# Search and replace
sed 's/old/new/g' file.txt

# Sort lines
sort file.txt

# Remove duplicates
sort file.txt | uniq
```

## Database Operations

### SQLite
```bash
# Open database
sqlite3 database.db

# Execute query
sqlite3 database.db "SELECT * FROM table;"

# Import SQL file
sqlite3 database.db < import.sql
```

### PostgreSQL
```bash
# Connect to database
psql -U username -d database

# Execute query
psql -U username -d database -c "SELECT * FROM table;"

# Import SQL file
psql -U username -d database < import.sql
```

## Monitoring and Logging

### Log Files
```bash
# View log file
tail -f /var/log/syslog

# Search logs
grep "error" /var/log/syslog

# View recent logs
tail -n 100 /var/log/syslog
```

### System Monitoring
```bash
# Real-time monitoring
htop
top

# I/O monitoring
iotop

# Network monitoring
iftop
netstat -an
```
