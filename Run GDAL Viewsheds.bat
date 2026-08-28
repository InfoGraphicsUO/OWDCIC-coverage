@echo off
setlocal

set "PROJECT_ROOT=%~dp0"

if defined OWDCIC_QGIS_ROOT goto qgis_found
if defined QGIS_ROOT set "OWDCIC_QGIS_ROOT=%QGIS_ROOT%"
if defined OWDCIC_QGIS_ROOT goto qgis_found
if defined OSGEO4W_ROOT set "OWDCIC_QGIS_ROOT=%OSGEO4W_ROOT%"
if defined OWDCIC_QGIS_ROOT goto qgis_found

if exist "C:\OSGeo4W\bin\o4w_env.bat" set "OWDCIC_QGIS_ROOT=C:\OSGeo4W"
if defined OWDCIC_QGIS_ROOT goto qgis_found
if exist "C:\OSGeo4W64\bin\o4w_env.bat" set "OWDCIC_QGIS_ROOT=C:\OSGeo4W64"
if defined OWDCIC_QGIS_ROOT goto qgis_found

for /f "delims=" %%D in ('dir /b /ad /o-d "%ProgramFiles%\QGIS *" 2^>nul') do if not defined OWDCIC_QGIS_ROOT set "OWDCIC_QGIS_ROOT=%ProgramFiles%\%%D"

:qgis_found
if not defined OWDCIC_QGIS_ROOT goto qgis_missing
if not exist "%OWDCIC_QGIS_ROOT%\bin\o4w_env.bat" goto qgis_missing

call "%OWDCIC_QGIS_ROOT%\bin\o4w_env.bat"
if exist "%OWDCIC_QGIS_ROOT%\bin\qt6_env.bat" (
    call "%OWDCIC_QGIS_ROOT%\bin\qt6_env.bat"
) else if exist "%OWDCIC_QGIS_ROOT%\bin\qt5_env.bat" (
    call "%OWDCIC_QGIS_ROOT%\bin\qt5_env.bat"
)
if exist "%OWDCIC_QGIS_ROOT%\bin\py3_env.bat" call "%OWDCIC_QGIS_ROOT%\bin\py3_env.bat"

if exist "%OWDCIC_QGIS_ROOT%\bin\python-qgis.bat" goto python_qgis
if exist "%OWDCIC_QGIS_ROOT%\bin\python3.exe" goto python_exe

echo QGIS Python was not found under:
echo   %OWDCIC_QGIS_ROOT%
echo Reinstall QGIS with its Python components or set OWDCIC_QGIS_ROOT.
pause
exit /b 1

:python_qgis
call "%OWDCIC_QGIS_ROOT%\bin\python-qgis.bat" "%PROJECT_ROOT%scripts\gdal-viewshed-gui.py"
exit /b %errorlevel%

:python_exe
"%OWDCIC_QGIS_ROOT%\bin\python3.exe" "%PROJECT_ROOT%scripts\gdal-viewshed-gui.py"
exit /b %errorlevel%

:qgis_missing
echo QGIS was not found.
echo Install QGIS, or set OWDCIC_QGIS_ROOT to its install folder and run this launcher again.
echo Example: set OWDCIC_QGIS_ROOT=C:\Program Files\QGIS 4.2.1
pause
exit /b 1
