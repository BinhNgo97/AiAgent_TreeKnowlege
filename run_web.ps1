# Run Cognitive Graph Agent Ver02
Set-Location $PSScriptRoot

# Activate venv nếu có
if (Test-Path ".\.venv\Scripts\Activate.ps1") {
    .\.venv\Scripts\Activate.ps1
}

# Install dependencies
pip install -r requirements.txt --quiet

# Run server — bind 0.0.0.0 để nhận kết nối từ LAN
uvicorn webapp.main:app --host 0.0.0.0 --port 8001 --reload
