# Librarium

Tu biblioteca personal y cuaderno de lectura: guardá tus libros, notas, anotaciones con fotos y citas, y conversá con una IA sobre cualquier pasaje.

**Usala directamente:** https://pritagoras.github.io/librarium/ (funciona en el celular y en la computadora, sin instalar nada).

## Empezar en 3 pasos
1. Abrí el link y tocá **＋ Añadir** para cargar tu primer libro (a mano, buscándolo en Open Library o escaneando el ISBN).
2. Agregá notas, citas o anotaciones con foto mientras leés.
3. Para usar la IA, pegá tu clave de Gemini en **⚙ Ajustes → Ajustes de IA** (ver abajo).

### Instalarla como aplicación
- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** botón Compartir → *Agregar a pantalla de inicio*.
- **Computadora (Chrome/Edge):** ícono de instalar en la barra de direcciones, o *Ajustes → Instalar Librarium*.

Instalarla en el iPhone es importante: Safari puede borrar los datos de los sitios que no se usan por un tiempo, y las aplicaciones instaladas están más protegidas.

## Funciones
- Biblioteca con estados de lectura, puntuación, reseña, etiquetas y progreso diario.
- Carga manual, búsqueda en Open Library y escaneo de ISBN con la cámara.
- Importación de notas finales desde JSON (ver formato más abajo), con secciones cuando la numeración reinicia.
- Notas, anotaciones con fotografías y citas (con transcripción de fotos por IA).
- **Chat con IA a pantalla completa**: mantené apretada una nota, anotación o cita (o tocá el ícono ✦) para conversar sobre ella. La charla se guarda y podés retomarla.
- **Conversaciones con la IA**: desde la Biblioteca, un banner abre la lista de todas tus charlas agrupadas por libro, con buscador.
- La IA pasa sola a otro modelo si el elegido falla, se traba o corta la respuesta.
- Ficha del libro y etiquetas sugeridas, síntesis de ideas y borrador de reseña con IA.
- Modo oscuro, copia de seguridad y restauración.

## Cómo conseguir tu clave de Gemini (gratis)
La IA no tiene una clave compartida: cada persona usa la suya.
1. Entrá a https://aistudio.google.com/apikey con tu cuenta de Google.
2. Creá una clave y copiala.
3. Pegala en **⚙ Ajustes → Ajustes de IA** y guardala.

La clave queda guardada **solo en el navegador de ese dispositivo, sin cifrar**, y no se incluye en copias de seguridad ni en la sincronización. No la compartas ni la uses en una computadora que no sea tuya. El plan gratuito de Google tiene límites de uso diarios; si te quedás sin cupo, esperá o probá con otro modelo.

## Tus datos y tu privacidad
- **Sin iniciar sesión**, todo se guarda únicamente en tu navegador (IndexedDB). No se envía a ningún servidor de Librarium.
- **Al iniciar sesión con Google**, tus libros, notas, citas, fotos y conversaciones se sincronizan con la base de datos del proyecto Librarium (Firebase), para que puedas usarlos en varios dispositivos. Si preferís que nada salga de tu dispositivo, no inicies sesión.
- **Al usar la IA**, el texto y las fotos que consultás se envían a Google (Gemini) con tu propia clave.
- La búsqueda de libros usa Open Library y las portadas por URL se descargan desde el proveedor indicado.

**Hacé copias de seguridad.** En *⚙ Ajustes → Copia de seguridad* se descarga un JSON con todo (libros, notas, anotaciones, imágenes y conversaciones). *Restaurar copia* incorpora o actualiza los registros por ID, sin borrar los datos actuales. No borres los datos del sitio si no tenés una copia.

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
También acepta `referencePage` y `endPage` en camelCase. `reference_page` es opcional: omitilo (o usá `null`) cuando las notas no tengan una página de referencia en el texto principal. `end_page` es la página donde aparece la nota y también puede omitirse o ser `null`. Al importar, se agregan al libro abierto. Si la numeración reinicia (por ejemplo, vuelve de 25 a 1), se crea una sección nueva.

## Para desarrolladores
Requiere Node.js 22 o superior.

```bash
npm install
npm run dev      # servidor de desarrollo en http://127.0.0.1:8765
npm run build    # genera dist/
npm run lint     # chequeo de tipos y reglas de Firestore
```

En Windows también podés usar `INSTALAR.bat` (una vez) e `INICIAR_LIBRARIUM.bat`.

### Publicar en GitHub Pages
El flujo de GitHub Actions incluido publica el sitio en cada cambio a `main`. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### Usar tu propio Firebase
La sincronización usa la configuración de `firebase-applet-config.json`. Si publicás tu propia copia, creá tu proyecto de Firebase, reemplazá ese archivo, agregá tu dominio en *Authentication → Dominios autorizados* y publicá las reglas de `firestore.rules` en tu base de datos. Más detalle de las reglas en `security_spec.md`.

## Limitaciones
- La búsqueda de libros y la IA necesitan internet.
- Las portadas por URL dependen de que el proveedor siga disponible.
- Las imágenes van incluidas en la copia de seguridad, que puede volverse grande.
- Las notas de voz todavía no están disponibles.
