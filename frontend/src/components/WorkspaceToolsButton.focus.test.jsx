import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { NotesModal } from './NotesModal';
import { BookmarkModal } from './BookmarkModal';

afterEach(cleanup);
const note={id:'synthetic-note',title:'Synthetic note',content:'Fixture text',category:'Fixture',createdAt:'2026-10-25'};
const bookmark={id:'synthetic-bookmark',name:'Synthetic bookmark',command:'echo fixture',category:'Fixture'};
function Fixture({kind}) {const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Open fixture</button><button>Background control</button>{kind==='notes'?<NotesModal isOpen={open} onClose={()=>setOpen(false)} notes={[note]} onUpdate={async()=>{}} />:<BookmarkModal isOpen={open} onClose={()=>setOpen(false)} bookmarks={[bookmark]} />}</>;}

describe.each(['notes','bookmarks'])('%s modal keyboard containment',kind=>{
 it('moves focus into the dialog, contains it, and restores the opener after Escape',async()=>{
  render(<Fixture kind={kind}/>);
  const opener=screen.getByRole('button',{name:'Open fixture'});opener.focus();fireEvent.click(opener);
  const dialog=screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);
  screen.getByRole('button',{name:'Background control'}).focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async()=>fireEvent.keyDown(document.activeElement,{key:'Escape'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
 });
 it('wraps backward from its first visible control',()=>{
  render(<Fixture kind={kind}/>);fireEvent.click(screen.getByRole('button',{name:'Open fixture'}));
  const close=screen.getByRole('button',{name:'Close'});close.focus();fireEvent.keyDown(close,{key:'Tab',shiftKey:true});
  const buttons=screen.getAllByRole('button').filter(button=>button.closest('[role=dialog]'));
  expect(buttons.at(-1)).toHaveFocus();
 });
});

it.each(['notes','bookmarks'])('preserves %s during a composing Escape',async kind=>{
 render(<Fixture kind={kind}/>);fireEvent.click(screen.getByRole('button',{name:'Open fixture'}));
 if(kind==='notes')await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New Note'})));
 else fireEvent.click(screen.getByTitle('Add bookmark'));
 const input=screen.getByLabelText(kind==='notes'?'Note title':'Name');
 fireEvent.change(input,{target:{value:'Composition draft'}});
 fireEvent.keyDown(input,{key:'Escape',isComposing:true,keyCode:229});
 expect(screen.getByRole('dialog')).toBeInTheDocument();
 expect(screen.getByLabelText(kind==='notes'?'Note title':'Name')).toHaveValue('Composition draft');
});
