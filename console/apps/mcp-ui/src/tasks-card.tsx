// The tasks card's entry (#467).
import { version } from '../package.json';
import { mountWidget } from './shared/mount';
import { TASKS_CARD_TOOLS, TasksCard } from './TasksCard';
import './styles.css';

mountWidget({ name: 'Hexactra tasks card', version }, TASKS_CARD_TOOLS, (host) => <TasksCard host={host} />);
