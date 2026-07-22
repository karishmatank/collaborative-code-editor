import unittest
from app import app
from database import DatabaseManager
import os
from psycopg2.extras import DictCursor

class TestPersistence(unittest.TestCase):
    """Test suite for persistence API"""

    def setUp(self):
        app.config['TESTING'] = True
        self.database = DatabaseManager(app.config['TESTING'])
        self.client = app.test_client()

        # Seed data for testing
        self.database.create_pad('1')
        self.database.create_pad_content('1', 'python')

    def tearDown(self):
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        DELETE FROM pads;
                        DELETE FROM pad_contents;
                    """
                )
    
    def test_create_pad(self):
        """Test that we can successfully create a pad"""
        # Currently, we should only see one pad
        query = """
            SELECT count(id)
            FROM pads;
        """
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], 1)

        response = self.client.post(
            '/api/pads',
            headers={
                'Authorization': f'Bearer {os.getenv('AUTH_TOKEN')}'
            }
        )

        self.assertEqual(response.status_code, 201)
        
        # We should now see 2 pads
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], 2)
    
    def test_no_auth(self):
        """Test that we can't create a pad without an auth token"""
        response = self.client.post(
            '/api/pads'
        )

        self.assertEqual(response.status_code, 401)

        # We should only see one pad
        query = """
            SELECT count(id)
            FROM pads;
        """
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], 1)

    def test_incorrect_request_type(self):
        """Test that we can't create a pad using a GET request"""
        response = self.client.get(
            '/api/pads'
        )
        self.assertEqual(response.status_code, 405) # Method not allowed
    
    def test_get_language(self):
        """Test that we get the right language for a given pad"""
        response = self.client.get('/api/pads/1')
        body = response.get_json()
        self.assertTrue('language' in body)
        self.assertEqual(body['language'], 'python')

    def test_get_language_nonexistent_pad(self):
        """Test that we can't get the language of a nonexistent pad"""
        response = self.client.get('/api/pads/456')
        body = response.get_json()
        self.assertTrue('error' in body)
        self.assertTrue('language' not in body)
        self.assertEqual(body['error'], 'Pad not found')
        self.assertEqual(response.status_code, 404)

    def test_update_language(self):
        """Test successful language update for a given pad ID"""
        query = """
            SELECT *
            FROM pads
            WHERE id = '1';
        """
        with self.database._database_connection() as connection:
            with connection.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()['current_language'], 'python')

        response = self.client.patch(
            '/api/pads/1',
            json={'language': 'ruby'}
        )

        self.assertEqual(response.status_code, 204)

        # Check to see if database was successfully updated
        with self.database._database_connection() as connection:
            with connection.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()['current_language'], 'ruby')

    def test_update_language_no_json(self):
        """Test unsuccessful language update if we don't provide language info"""
        query = """
            SELECT *
            FROM pads
            WHERE id = '1';
        """
        with self.database._database_connection() as connection:
            with connection.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()['current_language'], 'python')

        response = self.client.patch(
            '/api/pads/1',
            json={}
        )

        self.assertEqual(response.status_code, 400)

        # Check to see that the language didn't change
        with self.database._database_connection() as connection:
            with connection.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()['current_language'], 'python')

    def test_update_language_nonexistent_pad(self):
        """Test that we get an error for updating the language of a pad that doesn't exist"""
        response = self.client.patch(
            '/api/pads/456',
            json={'language': 'ruby'}
        )
        body = response.get_json()
        self.assertTrue('error' in body)
        self.assertTrue('language' not in body)
        self.assertEqual(body['error'], 'Pad not found')
        self.assertEqual(response.status_code, 404)

    def test_get_content(self):
        """Test that we get back the correct content for a given pad and language"""
        self.database.update_pad_content('1', 'python', 'print("hello world")')

        response = self.client.get(
            '/api/pads/1/content/python'
        )

        self.assertEqual(response.status_code, 200)

        body = response.get_json()
        self.assertEqual(body['content'], 'print("hello world")')

    def test_get_content_no_content(self):
        """Test that we get back an empty string if content is NULL for a given pad and language"""
        response = self.client.get(
            '/api/pads/1/content/python'
        )

        self.assertEqual(response.status_code, 200)

        body = response.get_json()
        self.assertEqual(body['content'], '')

    def test_contact_row_added(self):
        """If there was no prior entry for a pad and language in `pad_contents`, it is added"""
        self.database.create_pad('2')

        # Make sure there are no rows in the contents table for this pad
        query = """
            SELECT count(id)
            FROM pad_contents
            WHERE pad_id = '2' AND language = 'python';
        """
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], 0)

        response = self.client.get(
            '/api/pads/2/content/python'
        )
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body['content'], '')

        # There should be a row now
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], 1)

    def test_update_content(self):
        """Test successful content update"""
        # Check content prior to update
        query = """
            SELECT content
            FROM pad_contents
            WHERE pad_id = '1' AND language = 'python';
        """
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], None)

        response = self.client.patch(
            '/api/pads/1/content/python',
            json={'content': 'print("Goodbye")'}
        )
        self.assertEqual(response.status_code, 204)

        # Check contents after
        with self.database._database_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()[0], 'print("Goodbye")')

    def test_update_content_nonexistent_pad(self):
        """Test that we get an error for updating the content of a pad that doesn't exist"""
        response = self.client.patch(
            '/api/pads/456/content/python',
            json={'content': 'print("Goodbye")'}
        )
        body = response.get_json()
        self.assertTrue('error' in body)
        self.assertTrue('content' not in body)
        self.assertEqual(body['error'], 'Pad not found')
        self.assertEqual(response.status_code, 404)

    def test_update_content_nonexistent_language(self):
        """Test that we get an error for updating the content of a language that is invalid"""
        response = self.client.patch(
            '/api/pads/1/content/rust',
            json={'content': 'print("Goodbye")'}
        )
        body = response.get_json()
        self.assertTrue('error' in body)
        self.assertTrue('content' not in body)
        self.assertEqual(body['error'], 'Pad language is invalid')
        self.assertEqual(response.status_code, 404)

    def test_update_content_no_json(self):
        """Test unsuccessful content update if we don't provide content info"""
        query = """
            SELECT *
            FROM pad_contents
            WHERE pad_id = '1' AND language = 'python';
        """
        with self.database._database_connection() as connection:
            with connection.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()['content'], None)

        response = self.client.patch(
            '/api/pads/1/content/python',
            json={}
        )

        self.assertEqual(response.status_code, 400)

        # Check to see that the language didn't change
        with self.database._database_connection() as connection:
            with connection.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute(query)
                self.assertEqual(cursor.fetchone()['content'], None)
    
    def test_update_content_no_row(self):
        """If, for some reason, 
        we try to update the content for a pad ID / language combo that doesn't exist, 
        return an error"""

        response = self.client.patch(
            '/api/pads/1/content/sql',
            json={'content': 'SELECT * FROM table;'}
        )

        self.assertEqual(response.status_code, 400)

        body = response.get_json()
        self.assertEqual(body['error'], 'Pad language combo does not exist')


if __name__ == '__main__':
    unittest.main()