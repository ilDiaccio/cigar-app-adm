@echo off
setlocal enabledelayedexpansion

echo ==========================================================
echo        ACCESSO DA SMARTPHONE A CIGAR APP
echo ==========================================================
echo.
echo Assicurati di aver prima avviato l'app con "Avvia Cigar App.bat".
echo Il tuo PC e il tuo smartphone devono essere connessi alla stessa rete Wi-Fi.
echo.
echo 1. Prendi il tuo smartphone.
echo 2. Apri il browser (Chrome, Safari, Firefox).
echo 3. Digita uno dei seguenti indirizzi nella barra degli URL:
echo.

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    set ip=%%a
    set ip=!ip: =!
    echo    http://!ip!:3000
)

echo.
echo ==========================================================
echo [SUGGERIMENTO PWA - COME UN'APP VERA]
echo Dal browser del telefono, apri il menu delle opzioni 
echo (i tre puntini o l'icona di condivisione) e seleziona 
echo "Aggiungi a schermata Home" o "Installa app".
echo Questo creera un'icona sul telefono esattamente come un'app nativa.
echo ==========================================================
echo.
pause