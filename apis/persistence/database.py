from contextlib import contextmanager
from datetime import datetime, timezone
import psycopg2

class DatabaseManager:
    def __init__(self, is_testing):
       self.dbname = 'collab_pads' if not is_testing else 'collab_pads_test'
    
    @contextmanager
    def _database_connection(self):
        """Manage the database connection dynamics"""
        connection = psycopg2.connect(dbname=self.dbname)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def is_existing_pad(self, pad_id):
        """Check to make sure pad ID exists in the database"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        SELECT *
                        FROM pads
                        WHERE id = %s;
                    """,
                    (pad_id,)
                )
                result = cursor.fetchone()
                return result is not None
    
    def get_pad_language(self, pad_id):
        """Gets the current language of a pad"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        SELECT current_language
                        FROM pads
                        WHERE id = %s;
                    """,
                    (pad_id,)
                )
                result = cursor.fetchone()
                return result[0] if result is not None else None
    
    def update_pad_language(self, pad_id, new_language):
        """Updates the current language of a pad"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        UPDATE pads
                        SET current_language = %s, updated_at = %s
                        WHERE id = %s;
                    """,
                    (new_language, datetime.now(timezone.utc), pad_id)
                )

    def get_pad_content(self, pad_id, language):
        """Gets the last seen content of a pad for a given language"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        SELECT content
                        FROM pad_contents
                        WHERE pad_id = %s AND language = %s;
                    """,
                    (pad_id, language)
                )
                result = cursor.fetchone()
                if result is None:
                    self.create_pad_content(pad_id, language)
                    return ''
                return result[0] or ''

    def update_pad_content(self, pad_id, language, content):
        """Updates the last seen content of a pad for a given language"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        UPDATE pad_contents
                        SET content = %s, updated_at = %s
                        WHERE pad_id = %s AND language = %s;
                    """,
                    (content, datetime.now(timezone.utc), pad_id, language)
                )
    
    def create_pad(self, new_pad_id):
        """Creates a new pad"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        INSERT INTO pads (id) VALUES (%s);
                    """,
                    (new_pad_id,)
                )
    
    def create_pad_content(self, pad_id, language):
        """Creates a new row in pad_contents to keep track of a language's content in a pad"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        INSERT INTO pad_contents (pad_id, language) VALUES (%s, %s);
                    """,
                    (pad_id, language)
                )
    
    def pad_language_combo_exists(self, pad_id, language):
        """Check if pad ID and language combo exists"""
        with self._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        SELECT count(id)
                        FROM pad_contents
                        WHERE pad_id = %s AND language = %s;
                    """,
                    (pad_id, language)
                )

                return cursor.fetchone()[0] == 1