-- "Save this login?" (E37.4b): a question the server makes after the owner signs in by hand through a card;
-- answered only in the signed-in web and Android app, never stored with the password.
ALTER TYPE "question_input" ADD VALUE 'save_login';
