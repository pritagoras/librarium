# Librarium

Biblioteca personal y cuaderno de lectura. Aplicación web local, con datos almacenados en IndexedDB.

## Requisitos
- Windows 10/11
- Python 3 instalado (para iniciar el servidor local)
- Navegador moderno (Chrome o Edge recomendado)

## Inicio
1. Extraé esta carpeta en `C:\Users\Prita\Documents\GitHub\Librarium`.
2. Ejecutá `INSTALAR.bat` una vez.
3. Ejecutá `INICIAR_LIBRARIUM.bat` cada vez que quieras usar la aplicación.
4. Para cerrar el servidor, volvé a la ventana negra y presioná Ctrl+C.

## Publicar en GitHub Pages

Librarium es una aplicación estática y puede publicarse en GitHub Pages sin Python. El flujo de GitHub Actions incluido despliega el contenido de este repositorio automáticamente. En GitHub, configurá **Settings → Pages → Build and deployment → Source: GitHub Actions**; luego cada cambio enviado a `main` se publica en Pages.

La versión publicada guarda los datos en IndexedDB del navegador bajo el dominio de GitHub Pages. Es un almacenamiento separado del sitio local `127.0.0.1`; exportá una copia de seguridad desde la versión local y restaurala en Pages si querés llevar tus datos. Los datos no se sincronizan entre dispositivos. El código del sitio queda visible para quienes puedan acceder al repositorio.

## Funciones incluidas
- Biblioteca con alta, edición y eliminación de libros.
- Carga manual y búsqueda opcional en Open Library.
- Portadas por archivo o URL.
- Página actual y estados de lectura.
- Importación de notas finales pegando JSON o seleccionando un archivo, con validación y vista previa.
- Carga manual de notas con número, página de referencia y página de nota.
- Marcado de notas leídas y exportación de notas.
- Anotaciones y fotografías asociadas a páginas.
- Copia de seguridad de libros, notas y registros.

## Formato JSON de notas
```json
{
  "schema_version": 1,
  "book": {"title": "Título del libro", "author": "Autor"},
  "notes": [
    {
      "number": 1,
      "reference_page": 12,
      "end_page": 245,
      "text": "Texto de la nota",
      "read": false
    }
  ]
}
```

También acepta `referencePage` y `endPage` en formato camelCase. `reference_page` es opcional: omitilo (o usá `null`) cuando las notas no tengan una página de referencia en el texto principal. `end_page` es la página donde aparece la nota y también puede omitirse o ser `null`. Al importar, se agregan al libro abierto en ese momento. Si la numeración reinicia (por ejemplo, vuelve de 25 a 1), se crea una sección nueva y los números pueden repetirse en secciones distintas. La vista de notas muestra esas secciones por separado.

## Copias de seguridad
El botón "Copia de seguridad" descarga un JSON con todos los libros, notas y anotaciones, incluidas las imágenes. Para restaurar, hacé clic derecho sobre ese botón y seleccioná la copia JSON. La restauración incorpora/actualiza registros por ID; no elimina los datos actuales.

## Datos y privacidad
Los datos se guardan en el perfil del navegador mediante IndexedDB. No se envían a un servidor. La búsqueda de catálogo consulta Open Library y las portadas URL se descargan desde el proveedor indicado. Evitá borrar los datos del sitio si no tenés una copia de seguridad.

## Limitaciones de esta primera entrega
- La búsqueda externa necesita internet.
- Las portadas ingresadas como URL requieren que el proveedor siga disponible.
- La copia de seguridad es un JSON único; las imágenes se incluyen como data URLs y pueden hacer que el archivo sea grande.
- Las notas de voz y sincronización entre dispositivos quedan para futuras versiones.
- Para actualizar la aplicación, reemplazá los archivos de la aplicación conservando el mismo perfil del navegador y exportá una copia de seguridad antes.

