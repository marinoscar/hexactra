// The question card's entry (#467).
import { version } from '../package.json';
import { QUESTION_CARD_TOOLS, QuestionCard } from './QuestionCard';
import { mountWidget } from './shared/mount';
import './styles.css';

mountWidget({ name: 'Hexactra question card', version }, QUESTION_CARD_TOOLS, (host) => <QuestionCard host={host} />);
